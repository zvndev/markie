import UIKit
import WebKit
import Capacitor

/// Capacitor's bridge view controller, taking plugin calls from the app's own
/// page and nowhere else.
///
/// WKWebView hands a script message handler to every frame in the page,
/// including the sandboxed srcdoc frame a trusted Darkmown document runs in.
/// That frame only runs Markie's pinned interpreter (its policy names the
/// interpreter's hashes and nothing else), but no plugin call has any business
/// coming from it, so calls from any frame but the main one are dropped here.
/// This is the rule Capacitor's Android bridge already applies.
///
/// It also turns off URLSession's response cache. Capacitor's native HTTP
/// makes every request on a session built from URLSessionConfiguration.default,
/// which stores responses in URLCache.shared: an on-disk Cache.db in
/// Library/Caches that would otherwise keep the bearer token from the sign-in
/// answer and the full text of every private document opened. The app sends
/// `Cache-Control: no-store` and the server answers with it too; a cache with
/// no capacity means nothing depends on either side remembering.
class MarkieBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        // Runs inside loadView, before viewDidLoad loads the page, so before
        // the app can make a single request.
        URLCache.shared.removeAllCachedResponses()
        URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, directory: nil)
        super.capacitorDidLoad()
        guard let handler = (bridge as? CapacitorBridge)?.webViewDelegationHandler else { return }
        let controller = handler.contentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(MainFrameOnlyMessageHandler(handler), name: "bridge")
    }
}

private final class MainFrameOnlyMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var inner: WKScriptMessageHandler?

    init(_ inner: WKScriptMessageHandler) {
        self.inner = inner
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        inner?.userContentController(userContentController, didReceive: message)
    }
}
