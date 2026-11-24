import Capacitor
import UIKit
import WebKit

/// Prints a page of HTML to a PDF file, off screen (src/lib/export.ts).
///
/// The page is loaded in a web view of its own that sits behind the app's
/// window content, where nobody sees it, and printed with the web view's own
/// print formatter: real pages, selectable text, the stylesheet's page breaks.
/// The app's own web view is never touched.
///
/// The caller gives the page size, the margins and the paper colour, in PDF
/// points. One CSS pixel is printed as 0.75 pt, as Chromium prints it, so a
/// PDF from the phone has the same measure as one from the desktop.
///
/// Registered in MarkieBridgeViewController.capacitorDidLoad.
@objc(MarkiePdfPlugin)
public class MarkiePdfPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MarkiePdfPlugin"
    public let jsName = "MarkiePdf"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "render", returnType: CAPPluginReturnPromise)
    ]

    /// One at a time: each job owns a web view.
    private var job: PdfJob?

    @objc func render(_ call: CAPPluginCall) {
        guard let html = call.getString("html"), let path = call.getString("path"),
              let width = call.getDouble("pageWidth"), let height = call.getDouble("pageHeight"),
              width >= 72, width <= 2000, height >= 72, height <= 2000 else {
            call.reject("The PDF request was incomplete.")
            return
        }
        let margins = UIEdgeInsets(
            top: CGFloat(max(0, call.getDouble("marginTop") ?? 0)), left: CGFloat(max(0, call.getDouble("marginLeft") ?? 0)),
            bottom: CGFloat(max(0, call.getDouble("marginBottom") ?? 0)), right: CGFloat(max(0, call.getDouble("marginRight") ?? 0)))
        guard CGFloat(width) - margins.left - margins.right >= 36, CGFloat(height) - margins.top - margins.bottom >= 36,
              let target = MarkiePdfPlugin.cacheFile(path) else {
            call.reject("The PDF request was incomplete.")
            return
        }
        let background = MarkiePdfPlugin.colour(call.getString("background") ?? "#ffffff")

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.job == nil else {
                call.reject("Markie is already making a PDF. Wait for that one to finish.")
                return
            }
            guard let window = self.bridge?.viewController?.view.window else {
                call.reject("Markie has to be open to make a PDF.")
                return
            }
            let job = PdfJob(html: html, target: target, page: CGSize(width: width, height: height), margins: margins, background: background) { [weak self] error in
                self?.job = nil
                if let error = error {
                    call.reject(error)
                } else {
                    call.resolve(["uri": target.absoluteString])
                }
            }
            self.job = job
            job.start(in: window)
        }
    }

    /// A file inside the app's cache folder and nowhere else. Caches is never backed up.
    private static func cacheFile(_ path: String) -> URL? {
        guard let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              !path.isEmpty, !path.hasPrefix("/"), path.lowercased().hasSuffix(".pdf") else { return nil }
        let target = cache.appendingPathComponent(path).standardizedFileURL
        guard target.path.hasPrefix(cache.standardizedFileURL.path + "/") else { return nil }
        return target
    }

    private static func colour(_ hex: String) -> UIColor {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return .white }
        return UIColor(
            red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}

/// A page renderer with the paper the caller asked for. UIKit declares both
/// rectangles read-only and sizes them for a printer; they are overridden for
/// code that asks the renderer, and set on the superclass's own storage for
/// the print formatter, which reads it there.
private final class PaperRenderer: UIPrintPageRenderer {
    private let paper: CGRect
    private let printable: CGRect

    init(paper: CGRect, printable: CGRect) {
        self.paper = paper
        self.printable = printable
        super.init()
        setValue(NSValue(cgRect: paper), forKey: "paperRect")
        setValue(NSValue(cgRect: printable), forKey: "printableRect")
    }

    override var paperRect: CGRect { paper }
    override var printableRect: CGRect { printable }
}

private final class PdfJob: NSObject, WKNavigationDelegate {
    /// CSS pixels per PDF point: 96 px to the inch against 72 pt.
    private static let pixelsPerPoint: CGFloat = 96.0 / 72.0
    /// How much wider than the sheet WebKit lays a page out before shrinking it to fit (see render()).
    private static let webKitPrintLayoutFactor: CGFloat = 1.25
    /// The whole job, and the wait for fonts and pictures inside it.
    private static let timeout: TimeInterval = 30
    private static let readyTimeout: TimeInterval = 8
    /// True once the page, its fonts and its pictures have loaded.
    private static let readyScript = """
    (function () { try { var f = document.fonts; return document.readyState === "complete" && (!f || f.status === "loaded") && Array.prototype.every.call(document.images, function (i) { return i.complete; }); } catch (e) { return true; } })()
    """

    private let html: String
    private let target: URL
    private let page: CGSize
    private let margins: UIEdgeInsets
    private let background: UIColor
    private var completion: ((String?) -> Void)?
    private var webView: WKWebView?
    private var loaded = false
    private var readyDeadline = Date.distantFuture

    init(html: String, target: URL, page: CGSize, margins: UIEdgeInsets, background: UIColor, completion: @escaping (String?) -> Void) {
        self.html = html
        self.target = target
        self.page = page
        self.margins = margins
        self.background = background
        self.completion = completion
    }

    /// The paper and the area inside its margins, in CSS pixels.
    private var paper: CGRect {
        CGRect(x: 0, y: 0, width: page.width * PdfJob.pixelsPerPoint, height: page.height * PdfJob.pixelsPerPoint)
    }
    private var printable: CGRect {
        let scale = PdfJob.pixelsPerPoint
        return paper.inset(by: UIEdgeInsets(top: margins.top * scale, left: margins.left * scale, bottom: margins.bottom * scale, right: margins.right * scale))
    }

    func start(in window: UIWindow) {
        let configuration = WKWebViewConfiguration()
        // Nothing the page loads is kept, and it shares no storage with the app.
        configuration.websiteDataStore = .nonPersistent()
        // As wide as the printed column, so anything the page measures before
        // printing (the desktop's fit script scales a wide table to the column)
        // is measured against the width it will print at.
        let view = WKWebView(frame: CGRect(origin: .zero, size: printable.size), configuration: configuration)
        view.navigationDelegate = self
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        // In the window, because a web view outside one never lays out; at the
        // bottom of it, under the app's own content.
        window.insertSubview(view, at: 0)
        webView = view
        view.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + PdfJob.timeout) { [weak self] in
            self?.finish("The PDF took too long and was stopped.")
        }
    }

    // The page is a document, not a site: nothing in it may take the web view
    // anywhere once it has loaded.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let subframe = navigationAction.targetFrame.map { !$0.isMainFrame } ?? false
        decisionHandler(loaded || subframe || navigationAction.navigationType != .other ? .cancel : .allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !loaded else { return }
        loaded = true
        readyDeadline = Date().addingTimeInterval(PdfJob.readyTimeout)
        waitUntilReady()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish("The document couldn't be laid out for a PDF.")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish("The document couldn't be laid out for a PDF.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish("The document couldn't be laid out for a PDF.")
    }

    /// Fonts and pictures first. A picture that never arrives costs the wait, not the PDF.
    private func waitUntilReady() {
        guard let view = webView, completion != nil else { return }
        view.evaluateJavaScript(PdfJob.readyScript) { [weak self] result, _ in
            guard let self = self, self.completion != nil else { return }
            let ready = (result as? Bool) == true || Date() >= self.readyDeadline
            // One more beat when ready, for the page's own last layout pass.
            DispatchQueue.main.asyncAfter(deadline: .now() + (ready ? 0.25 : 0.1)) { [weak self] in
                if ready { self?.render() } else { self?.waitUntilReady() }
            }
        }
    }

    private func render() {
        guard let view = webView, completion != nil else { return }
        // WebKit never prints a page at the width it is given. It lays the
        // page out 1.25 times wider and shrinks the result to fit (WebCore's
        // printingMinimumShrinkFactor), so on A4 every piece of text came out
        // a fifth smaller than the desktop prints it: 8.4 pt body for
        // 10.5 pt, measured on a simulator. So the renderer is handed a
        // column that is smaller by that factor, with no margins of its own.
        // WebKit then lays out at exactly the column's real width in CSS
        // pixels, and each page is drawn scaled back up, at the margins' offset.
        let shrink = 1 / PdfJob.webKitPrintLayoutFactor
        let column = CGRect(x: 0, y: 0, width: printable.width * shrink, height: printable.height * shrink)
        let renderer = PaperRenderer(paper: column, printable: column)
        renderer.addPrintFormatter(view.viewPrintFormatter(), startingAtPageAt: 0)

        let bounds = CGRect(origin: .zero, size: page)
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, bounds, nil)
        let pages = renderer.numberOfPages
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: pages))
        for index in 0..<pages {
            UIGraphicsBeginPDFPage()
            guard let context = UIGraphicsGetCurrentContext() else { continue }
            // The paper first, edge to edge: the web view paints only inside the margins.
            context.setFillColor(background.cgColor)
            context.fill(bounds)
            // The renderer works in CSS pixels; the page is in points.
            context.saveGState()
            context.scaleBy(x: 1 / PdfJob.pixelsPerPoint, y: 1 / PdfJob.pixelsPerPoint)
            context.translateBy(x: printable.minX, y: printable.minY)
            context.scaleBy(x: PdfJob.webKitPrintLayoutFactor, y: PdfJob.webKitPrintLayoutFactor)
            context.clip(to: column)
            renderer.drawPage(at: index, in: column)
            context.restoreGState()
        }
        UIGraphicsEndPDFContext()

        guard pages > 0 else {
            finish("The document couldn't be laid out for a PDF.")
            return
        }
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: target, options: .atomic)
            finish(nil)
        } catch {
            finish("The PDF couldn't be written.")
        }
    }

    /// Every way out comes through here once: the web view goes, then the answer.
    private func finish(_ error: String?) {
        guard let done = completion else { return }
        completion = nil
        webView?.navigationDelegate = nil
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
        done(error)
    }
}
