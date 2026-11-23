import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MarkieBridgeViewController()
        window?.makeKeyAndVisible()

        Self.keepFilesOpenedInPlace(connectionOptions.urlContexts)
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// "Open in Markie" from Files hands over the person's own file, not a
    /// copy (LSSupportsOpeningDocumentsInPlace). Permission to use it rides on
    /// this URL object alone, and the page only ever receives the URL as text,
    /// so the file is remembered here first (LocalFilesStore.noteIncoming).
    /// A copy in Documents/Inbox (Mail, AirDrop) needs no permission and is
    /// left to the page, as before.
    private static func keepFilesOpenedInPlace(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts where context.url.isFileURL && context.options.openInPlace {
            LocalFilesStore.shared.noteIncoming(url: context.url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        Self.keepFilesOpenedInPlace(URLContexts)
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
