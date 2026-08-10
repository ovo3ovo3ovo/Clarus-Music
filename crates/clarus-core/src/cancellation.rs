use std::sync::Arc;

use tokio::sync::watch;

use crate::CoreError;

/// Cooperative cancellation shared by a core request and the task that owns it.
///
/// Tokio task abortion is still useful at the UI boundary, but it is not a
/// sufficient contract for other clients: a caller may need to cancel a
/// request while keeping the task alive long enough to perform cleanup.  The
/// token therefore has an explicit, allocation-light signal that can be
/// selected alongside HTTP, cache, or timer futures.
#[derive(Clone, Debug)]
pub struct RequestCancellation {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    cancelled: watch::Sender<bool>,
}

impl Default for RequestCancellation {
    fn default() -> Self {
        Self::new()
    }
}

impl RequestCancellation {
    pub fn new() -> Self {
        let (cancelled, _) = watch::channel(false);
        Self {
            inner: Arc::new(Inner { cancelled }),
        }
    }

    /// Permanently marks this request as cancelled.  Repeated calls are
    /// idempotent and never allocate another notification.
    pub fn cancel(&self) {
        self.inner.cancelled.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.inner.cancelled.borrow()
    }

    /// Waits until [`Self::cancel`] is called. `watch` retains the state and
    /// version, so cancellation cannot be lost between creating the waiter
    /// and its first poll.
    pub async fn cancelled(&self) {
        let mut receiver = self.inner.cancelled.subscribe();
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }
}

pub(crate) async fn cancelable<T, F>(
    cancellation: &RequestCancellation,
    future: F,
) -> Result<T, CoreError>
where
    F: std::future::Future<Output = Result<T, CoreError>>,
{
    if cancellation.is_cancelled() {
        return Err(CoreError::Cancelled);
    }
    tokio::select! {
        _ = cancellation.cancelled() => Err(CoreError::Cancelled),
        result = future => result,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::RequestCancellation;

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_is_idempotent_and_wakes_waiters() {
        let token = RequestCancellation::new();
        let waiter = {
            let token = token.clone();
            tokio::spawn(async move { token.cancelled().await })
        };
        token.cancel();
        token.cancel();
        tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .expect("cancelled waiter should wake")
            .expect("waiter task should finish");
        assert!(token.is_cancelled());
        token.cancelled().await;
    }
}
