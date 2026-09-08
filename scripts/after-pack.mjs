// electron-builder afterPack hook (macOS).
//
// electron-builder injects boilerplate privacy usage strings for Camera,
// Microphone, Audio Capture and Bluetooth. Semaphore uses none of them in v1,
// and advertising them is actively harmful: the app then shows up in System
// Settings under Microphone, which is where people go looking when screen
// sharing asks for permission — and wonder why only audio is offered.
// Screen Recording needs no plist key at all (macOS lists the app once it
// attempts a capture), so the honest plist declares nothing.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const UNUSED_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
]

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const plist = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  )
  for (const key of UNUSED_KEYS) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'ignore' })
    } catch {
      // Key absent — nothing to remove.
    }
  }
  console.log(`  • stripped ${UNUSED_KEYS.length} unused privacy usage strings from Info.plist`)
}
