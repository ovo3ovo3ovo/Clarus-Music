use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CoreError {
    #[error("network error: {0}")]
    Network(String),
    #[error("api error: {0}")]
    Api(String),
    #[error("authentication required: {0}")]
    AuthRequired(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("secure storage error: {0}")]
    SecureStorage(String),
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("audio error: {0}")]
    Audio(String),
    #[error("cache error: {0}")]
    Cache(String),
    #[error("request cancelled")]
    Cancelled,
}

impl From<ncm_api_rs::NcmError> for CoreError {
    fn from(error: ncm_api_rs::NcmError) -> Self {
        let message = error.to_string();
        match error {
            ncm_api_rs::NcmError::Http(_) | ncm_api_rs::NcmError::Timeout(_) => {
                Self::Network(message)
            }
            ncm_api_rs::NcmError::AuthRequired(_) => Self::AuthRequired(message),
            ncm_api_rs::NcmError::InvalidParam(_) => Self::Invalid(message),
            ncm_api_rs::NcmError::RateLimited(_) => Self::Api(message),
            _ => Self::Api(message),
        }
    }
}
