//! The one tokio runtime live sessions run on inside the app. GPUI has its
//! own executor; sockets and REST calls need tokio's, so they get two small
//! worker threads of their own, started on first use.
use std::sync::OnceLock;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("markie-live")
            .enable_all()
            .build()
            .expect("the live-session runtime starts")
    })
}

pub fn handle() -> tokio::runtime::Handle {
    runtime().handle().clone()
}
