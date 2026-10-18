# Media viewers and web links

[Back to the guide](README.md) · [Document types](document-types.md)

Use the supplied `samples/Media-and-links.md`, `scene.png` and `clip.mp4` together. These are synthetic local samples, not private documents.

## Images and videos

In the editable rich Markdown view, double-click the image to open it. Clicking the image toggles its viewing size, not the document's saved size. Click the empty area outside it, use Close, or press Escape to dismiss. Keyboard focus should return to the document. Moving between images must not edit source.

The local video keeps its normal play/pause controls. Use **Expand** to open the larger viewer, then click outside, use Close or press Escape. Closing must stop playback and remove the viewer's video source. Explicit provider Play cards may open a video player; their Close/outside actions must remove the frame. On desktop, Escape must work even after focusing the player. Switching or hiding the source document must dismiss its viewer.

Try the same operations in light/dark modes and a narrow window. The viewer should cover the window rather than being cropped by the document scroller. None of these viewing operations should mark the document dirty or rewrite its media links.

## Web links and hover previews

Click an ordinary HTTP(S) link, including its hover card, to open the device's default browser. It must not create a web window inside Markie or navigate the editor away. Modified and middle clicks should still use the desktop browser. In editable Word text, retain selection behavior and use the existing link tool's Open action; read-only Word links can be activated directly.

Rest on a web link, or focus a keyboard-accessible link in a read-only document, to request a metadata card. Editable text retains the editor's normal caret and selection behavior. Moving quickly across links must not fetch every target. The card should show the destination hostname, stay reachable when moving the pointer onto it, and dismiss on Escape, scrolling, document changes or opening a blocking tool. Settings can turn link previews off immediately. Provider cards also wait for deliberate hover/focus before asking for metadata.

Previews fetch bounded metadata and safe raster thumbnails, not executable pages. They do not use Markie's account cookies or credentials. Private/special network addresses, risky credential-like URLs, nonstandard service ports, unsafe redirects and oversized responses are refused. Previews may be unavailable for a site; a permitted hover still reveals your device's IP to that site. Explicit browser navigation and local-file links are separate actions with their existing permissions.

Darkmown's offline sandbox remains unchanged: these media/network capabilities are not silently granted to `.wd` documents. Full in-app cross-format document navigation remains a separate feature.
