import type { ExpoConfig } from 'expo/config';

/**
 * Build-time configuration. Values come from the environment of the build (EAS secrets
 * for store builds), never from the repository:
 *   ONETAPPE_API_URL            e.g. https://api.onetappe.in/api/v1
 *   GOOGLE_MAPS_ANDROID_API_KEY / GOOGLE_MAPS_IOS_API_KEY  restricted to this app's ids
 */
const env = process.env as Record<string, string | undefined>;
const apiUrl = env['ONETAPPE_API_URL'] ?? 'http://localhost:3000/api/v1';

const config: ExpoConfig = {
  name: 'One Tappe',
  slug: 'onetappe-customer',
  scheme: 'onetappe',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  platforms: ['android', 'ios', 'web'],
  android: {
    package: 'in.onetappe.customer',
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION'],
    config: { googleMaps: { apiKey: env['GOOGLE_MAPS_ANDROID_API_KEY'] ?? '' } },
  },
  ios: {
    bundleIdentifier: 'in.onetappe.customer',
    supportsTablet: false,
    config: { googleMapsApiKey: env['GOOGLE_MAPS_IOS_API_KEY'] ?? '' },
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Your location finds your address so we can check the service is available there.',
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
          'Your location finds your address so we can check the service is available there.',
      },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: { apiUrl },
};

export default config;
