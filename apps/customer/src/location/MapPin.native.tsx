import { StyleSheet, Text, View } from 'react-native';
import MapView, { PROVIDER_GOOGLE, type Region } from 'react-native-maps';
import { colors, radius } from '@onetappe/mobile-kit';

/**
 * Google map with a fixed pin in the middle: the customer moves the map under the pin to
 * mark the exact door. The key is restricted to this app (see app.config.ts).
 */
export function MapPin({
  point,
  onChange,
}: {
  point: { lat: number; lng: number };
  onChange: (point: { lat: number; lng: number }) => void;
}) {
  const region: Region = {
    latitude: point.lat,
    longitude: point.lng,
    latitudeDelta: 0.004,
    longitudeDelta: 0.004,
  };
  return (
    <View style={styles.box}>
      <MapView
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        onRegionChangeComplete={(r) => onChange({ lat: r.latitude, lng: r.longitude })}
        showsUserLocation
        accessibilityLabel="Map: move it so the pin is on your door"
      />
      <View pointerEvents="none" style={styles.pinWrap}>
        <Text style={styles.pin}>📍</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    height: 220,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  pinWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  pin: { fontSize: 32, marginBottom: 32 },
});
