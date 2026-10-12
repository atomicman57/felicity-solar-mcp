# Mac menu bar and Apple widgets

The app and WidgetKit extension read the private cloud service using OAuth. The menu bar indicator shows grid availability; stale readings show unknown. WidgetKit refresh scheduling is controlled by macOS/iOS and is not a second-by-second live stream.

Install Xcode and XcodeGen, then run `xcodegen generate` in this directory. Open `FelicitySolar.xcodeproj`, choose your Apple signing team for both targets, and build the app for your Mac or iPhone. Use matching bundle IDs, OAuth callback scheme and shared Keychain entitlements when customizing the project.

In the Mac app, open **Cloud connection** (or **Connection settings…** in the menu). On iPhone, open the app settings. Enter the HTTPS cloud dashboard origin and choose **Sign in**. Authorize widget read access in the browser. Tokens are stored in Keychain; the provider login is not embedded in the app.

A properly signed app and extension can share their Keychain credentials. Unsigned builds are useful for compilation checks but do not prove installed widgets or credential sharing. After installing on iPhone, add Felicity Solar from the Home Screen widget picker. On macOS, add it from the widget gallery.

Cloud collection continues when the Mac is off. The Mac menu bar itself is visible only while that Mac runs; the iPhone widget independently fetches the cloud service.
