import type { ExpoConfig } from 'expo/config';

/**
 * Build-time configuration. Values come from the environment of the build (EAS secrets
 * for store builds), never from the repository:
 *   ONETAPPE_API_URL   e.g. https://api.onetappe.in/api/v1
 */
const env = process.env as Record<string, string | undefined>;
const apiUrl = env['ONETAPPE_API_URL'] ?? 'http://localhost:3000/api/v1';

const config: ExpoConfig = {
  name: 'One Tappe Partner',
  slug: 'onetappe-worker',
  scheme: 'onetappe-partner',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  platforms: ['android', 'ios', 'web'],
  android: {
    package: 'in.onetappe.partner',
    // No Android cloud/adb backups of app data (sessions stay on this device only).
    allowBackup: false,
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION'],
  },
  ios: {
    bundleIdentifier: 'in.onetappe.partner',
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Your location is shared with One Tappe only while you are online or on a job, to offer you nearby work and for your safety.',
    },
  },
  web: { bundler: 'metro', output: 'single' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Your location is shared with One Tappe only while you are online or on a job, to offer you nearby work and for your safety.',
      },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: { apiUrl },
};

export default config;
