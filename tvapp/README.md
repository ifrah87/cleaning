# Cleaning Board — the TV app

A WebView in a box, pointed at `cleaning.orfanerealestate.so/?tv=1` and told never to
let go. The app itself is still `index.html` and still ships the same way; this only
changes what the television does with it.

What it adds over opening the URL in a browser:

| | browser on the TV | this |
|---|---|---|
| Screen saver | takes over the board | held awake |
| After a power cut | forgets the page | reopens (see *Autostart*) |
| New code shipped | whenever someone reloads | reloads itself at 03:05 daily |
| Hotspot drops | error page until noticed | retries every 15s, and instantly on reconnect |
| Chrome, address bar | present, and typeable | none |

## Build

Needs JDK 17 and the Android command-line tools:

    brew install openjdk@17
    brew install --cask android-commandlinetools
    sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

Then:

    ./build.sh                    # → build/cleaning-tv.apk

There is no Gradle. The app has no library dependencies, so the build is the five SDK
tools called in order; see the comment at the top of `build.sh`.

## Put it on the TV

Once, on the TV:

1. **Settings → System → About →** press **Build** seven times. "You are now a developer."
2. **Settings → System → Developer options →** turn on **USB debugging** *and*
   **Network debugging** (some sets call the second one *ADB over network* or *Wireless
   debugging*).
3. **Settings → Network →** note the TV's IP address.

Then from this folder, with the laptop on the same wifi:

    TV=192.168.1.42 ./build.sh install

The TV shows a *"Allow debugging from this computer?"* dialog the first time — accept
it with the remote, and tick *always allow* so it does not ask on every update.

Shipping a change to the board afterwards needs nothing here at all: the page reloads
itself overnight. This APK only ever needs rebuilding when the kiosk behaviour itself
changes.

## Autostart, and the thing that might not work

The app asks Android to launch it at boot. **Android 10 and up are allowed to refuse**,
and televisions differ in whether they do. Test it the only way that gives a real
answer: pull the plug, put it back, and wait.

If it comes back on its own, you are done.

If it does not, the reliable fix is to make this app the TV's **home screen** — boot
lands here because there is nowhere else to land. That means the Google TV launcher is
gone and the set can no longer be used for anything else, which is fine for a board on
a wall and not fine for a TV anyone watches. It is a decision about the room, so it is
deliberately not switched on in the manifest. To switch it on, add to the activity's
intent filter in `AndroidManifest.xml`:

    <category android:name="android.intent.category.HOME" />
    <category android:name="android.intent.category.DEFAULT" />

rebuild, reinstall, and pick this app when the TV asks which launcher to use.

## The signing key

`keystore/cleaning-tv.jks`, generated on first build, **not committed, not backed up by
anything**. An update only installs over the top if it is signed with the same key; lose
it and the fix is uninstalling from the TV first, which is survivable but annoying.
Copy it somewhere that is not this laptop.

## Checking on it from a laptop

The WebView allows remote inspection, so the one screen nobody stands in front of can
still be debugged:

    adb connect <tv-ip>:5555

then open `chrome://inspect` in Chrome on the laptop. The board appears there with a
live console.

    adb -s <tv-ip>:5555 logcat -s CleaningTV chromium   # or watch it from the terminal
