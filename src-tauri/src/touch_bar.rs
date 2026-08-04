use anyhow::{anyhow, Result};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSButtonTouchBarItem, NSTitlebarSeparatorStyle, NSTouchBar, NSTouchBarItem,
    NSTouchBarItemIdentifier, NSWindow,
};
use objc2_foundation::{MainThreadMarker, NSArray, NSObjectProtocol, NSSet, NSString};
use tauri::{AppHandle, Emitter, Manager};

const TOUCH_BAR_ACTIONS: &[(&str, &str, &str)] = &[
    ("back", "Back", "touchbar.back"),
    ("forward", "Forward", "touchbar.forward"),
    ("search", "Search", "touchbar.search"),
    ("previous", "Previous", "touchbar.previous"),
    ("play", "Play/Pause", "touchbar.play"),
    ("next", "Next", "touchbar.next"),
    ("like", "Like", "touchbar.like"),
    ("queue", "Queue", "touchbar.queue"),
];

#[derive(Debug)]
struct TouchBarTargetIvars {
    app: AppHandle,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class is main-thread only.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = TouchBarTargetIvars]
    struct TouchBarTarget;

    // SAFETY: NSObjectProtocol has no additional implementation requirements.
    unsafe impl NSObjectProtocol for TouchBarTarget {}

    impl TouchBarTarget {
        #[unsafe(method(back:))]
        fn back(&self, _sender: &AnyObject) {
            self.emit("touchbar.back");
        }

        #[unsafe(method(forward:))]
        fn forward(&self, _sender: &AnyObject) {
            self.emit("touchbar.forward");
        }

        #[unsafe(method(search:))]
        fn search(&self, _sender: &AnyObject) {
            self.emit("touchbar.search");
        }

        #[unsafe(method(previous:))]
        fn previous(&self, _sender: &AnyObject) {
            self.emit("touchbar.previous");
        }

        #[unsafe(method(play:))]
        fn play(&self, _sender: &AnyObject) {
            self.emit("touchbar.play");
        }

        #[unsafe(method(next:))]
        fn next(&self, _sender: &AnyObject) {
            self.emit("touchbar.next");
        }

        #[unsafe(method(like:))]
        fn like(&self, _sender: &AnyObject) {
            self.emit("touchbar.like");
        }

        #[unsafe(method(queue:))]
        fn queue(&self, _sender: &AnyObject) {
            self.emit("touchbar.queue");
        }
    }
);

impl TouchBarTarget {
    fn new(mtm: MainThreadMarker, app: AppHandle) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TouchBarTargetIvars { app });
        // SAFETY: NSObject's init signature and ownership convention are fixed by AppKit.
        unsafe { msg_send![super(this), init] }
    }

    fn emit(&self, event: &'static str) {
        let _ = self.ivars().app.emit("application-menu-action", event);
    }
}

fn action_selector(action: &str) -> Sel {
    match action {
        "back" => sel!(back:),
        "forward" => sel!(forward:),
        "search" => sel!(search:),
        "previous" => sel!(previous:),
        "play" => sel!(play:),
        "next" => sel!(next:),
        "like" => sel!(like:),
        "queue" => sel!(queue:),
        _ => unreachable!("Touch Bar actions are defined statically"),
    }
}

fn item_identifier(action: &str) -> Retained<NSTouchBarItemIdentifier> {
    NSString::from_str(&format!("com.ovo3ovo3ovo.clarusmusic.touchbar.{action}"))
}

pub fn install(app: &AppHandle) -> Result<()> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| anyhow!("Touch Bar must be installed on the main thread"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| anyhow!("The main window was not available for Touch Bar setup"))?;
    let ns_window = window.ns_window()?;
    if ns_window.is_null() {
        return Err(anyhow!("The main NSWindow pointer was null"));
    }
    // Tauri's Overlay title bar is transparent but AppKit still draws its
    // automatic separator. It cuts through full-window content such as the
    // lyrics background, so keep the window chrome borderless as intended.
    // SAFETY: Tauri documents ns_window() as an NSWindow pointer on macOS.
    let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };
    ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);

    let target = TouchBarTarget::new(mtm, app.clone());
    let identifiers = TOUCH_BAR_ACTIONS
        .iter()
        .map(|(action, _, _)| item_identifier(action))
        .collect::<Vec<_>>();
    let items = TOUCH_BAR_ACTIONS
        .iter()
        .map(|(action, title, _)| {
            let identifier = item_identifier(action);
            let title = NSString::from_str(title);
            // SAFETY: Each selector is implemented by TouchBarTarget with the standard action signature.
            unsafe {
                NSButtonTouchBarItem::buttonTouchBarItemWithIdentifier_title_target_action(
                    &identifier,
                    &title,
                    Some(&target),
                    Some(action_selector(action)),
                    mtm,
                )
            }
            .into_super()
        })
        .collect::<Vec<Retained<NSTouchBarItem>>>();

    let touch_bar = NSTouchBar::new(mtm);
    touch_bar.setDefaultItemIdentifiers(&NSArray::from_retained_slice(&identifiers));
    touch_bar.setTemplateItems(&NSSet::from_retained_slice(&items));

    ns_window.setTouchBar(Some(&touch_bar));

    // Touch Bar button targets are weak, so keep this single app-lifetime target alive.
    let _ = Retained::into_raw(target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::TOUCH_BAR_ACTIONS;

    #[test]
    fn action_identifiers_are_complete_and_unique() {
        let action_names = TOUCH_BAR_ACTIONS
            .iter()
            .map(|(action, _, _)| *action)
            .collect::<HashSet<_>>();
        let events = TOUCH_BAR_ACTIONS
            .iter()
            .map(|(_, _, event)| *event)
            .collect::<HashSet<_>>();

        assert_eq!(action_names.len(), TOUCH_BAR_ACTIONS.len());
        assert_eq!(events.len(), TOUCH_BAR_ACTIONS.len());
        assert!(events.iter().all(|event| event.starts_with("touchbar.")));
    }
}
