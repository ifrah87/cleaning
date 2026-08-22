#!/usr/bin/env bash
#
# Build the TV kiosk APK.
#
# WHY THERE IS NO GRADLE HERE
# This app has zero library dependencies — it is two classes, a manifest and an icon
# against the android.jar that ships with the SDK. Gradle would add a wrapper jar, a
# plugin resolved from Google's maven, and a build that can only run when both of
# those download. What it would buy us in return is nothing we use. So the five tools
# the SDK already provides are called directly, in the order they actually run, and
# the whole build is legible in one screen.
#
#   aapt2 compile  →  aapt2 link  →  javac  →  d8  →  zipalign  →  apksigner
#
# Usage:  ./build.sh            builds  build/cleaning-tv.apk
#         ./build.sh install    builds, then pushes it to a TV over adb (see README)
set -euo pipefail
cd "$(dirname "$0")"

JAVA_HOME="${JAVA_HOME:-$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home}"
ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export JAVA_HOME
PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"; export PATH

API=34
BT="$ANDROID_HOME/build-tools/34.0.0"
ANDROID_JAR="$ANDROID_HOME/platforms/android-$API/android.jar"
OUT=build
APK="$OUT/cleaning-tv.apk"

# The signing key. An APK can only be upgraded in place by a build signed with the SAME
# key — a different one is, to Android, a different app from a stranger, and the install
# fails with a signature mismatch until somebody uninstalls the old one and loses the
# TV's place. So the key is generated once and then kept. It is NOT committed: see
# .gitignore. Back it up somewhere that is not this laptop.
KS=keystore/cleaning-tv.jks
KS_PASS=cleaningboard
KS_ALIAS=cleaningtv

[ -f "$ANDROID_JAR" ] || { echo "No android.jar at $ANDROID_JAR — run: sdkmanager \"platforms;android-$API\""; exit 1; }
[ -d "$BT" ] || { echo "No build-tools at $BT — run: sdkmanager \"build-tools;34.0.0\""; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT/res" "$OUT/classes" "$OUT/gen" keystore

if [ ! -f "$KS" ]; then
  echo "→ generating a signing key (first build only — back up $KS)"
  keytool -genkeypair -v -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Cleaning Board, O=Orfane Real Estate, C=SO" >/dev/null
fi

echo "→ compiling resources"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"

echo "→ linking resources + manifest"
"$BT/aapt2" link -o "$OUT/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest AndroidManifest.xml \
  -R "$OUT/res.zip" \
  --java "$OUT/gen" \
  --min-sdk-version 21 --target-sdk-version $API \
  --auto-add-overlay

echo "→ compiling java"
# -classpath rather than -bootclasspath: modern javac rejects the latter alongside a
# release target, and for compiling against android.jar the two are equivalent here.
javac -nowarn -source 8 -target 8 -encoding UTF-8 \
  -classpath "$ANDROID_JAR" \
  -d "$OUT/classes" \
  $(find java "$OUT/gen" -name '*.java') 2>&1 | grep -v 'bootstrap class path' || true

echo "→ dexing"
"$BT/d8" --release --min-api 21 --lib "$ANDROID_JAR" \
  --output "$OUT" $(find "$OUT/classes" -name '*.class')

echo "→ packaging"
cp "$OUT/base.apk" "$OUT/unaligned.apk"
(cd "$OUT" && zip -q unaligned.apk classes.dex)

echo "→ aligning + signing"
"$BT/zipalign" -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign \
  --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --ks-key-alias "$KS_ALIAS" \
  --min-sdk-version 21 \
  --out "$APK" "$OUT/aligned.apk"

rm -f "$OUT/unaligned.apk" "$OUT/aligned.apk" "$OUT/base.apk" "$OUT/res.zip"
echo
echo "✓ $APK  ($(du -h "$APK" | cut -f1))"
"$BT/apksigner" verify --print-certs "$APK" | head -2

if [ "${1:-}" = "install" ]; then
  # No apostrophe in this message: it lives inside ${VAR:?...} inside double quotes,
  # and one stray quote there breaks the whole script rather than this one line.
  : "${TV:?Set the TV address first, e.g.  TV=192.168.1.42 ./build.sh install}"
  echo
  echo "→ connecting to $TV"
  adb connect "$TV:5555"
  echo "→ installing (-r keeps the existing install's place)"
  adb -s "$TV:5555" install -r "$APK"
  echo "→ starting"
  adb -s "$TV:5555" shell monkey -p so.orfanerealestate.cleaningtv \
    -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null
  echo "✓ the board should be on the TV now"
fi
