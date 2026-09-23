import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { commonStrings, type Locale } from './strings';
import { colors, font, MIN_TOUCH, radius, space } from './theme';

export function Screen({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {footer}
    </SafeAreaView>
  );
}

export function Title({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.title} accessibilityRole="header" testID={testID}>
      {children}
    </Text>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.heading} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.muted]}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.body, styles.muted]}>{label}</Text>
      <Text style={styles.body}>{value}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  busy = false,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      accessibilityLabel={label}
      onPress={off ? undefined : onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        kind === 'secondary' && styles.secondary,
        kind === 'danger' && styles.danger,
        (pressed || off) && styles.dim,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={kind === 'secondary' ? colors.brand : colors.onBrand} />
      ) : (
        <Text style={[styles.buttonText, kind === 'secondary' && styles.secondaryText]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...input
}: TextInputProps & { label: string; error?: string | null }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label} nativeID={`${label}-label`}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={`${label}-label`}
        style={[styles.input, error ? styles.inputError : null]}
        placeholderTextColor={colors.muted}
        {...input}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

export function Notice({
  kind,
  children,
  reference,
  locale,
}: {
  kind: 'ok' | 'error' | 'warning';
  children: ReactNode;
  reference?: string | null;
  locale?: Locale;
}) {
  return (
    <View
      accessibilityRole={kind === 'error' ? 'alert' : 'summary'}
      accessibilityLiveRegion="polite"
      style={[
        styles.notice,
        kind === 'ok' && { backgroundColor: colors.okBackground, borderColor: colors.ok },
        kind === 'error' && { backgroundColor: colors.errorBackground, borderColor: colors.danger },
        kind === 'warning' && {
          backgroundColor: colors.warningBackground,
          borderColor: colors.warning,
        },
      ]}
    >
      <Text style={styles.body}>{children}</Text>
      {reference ? (
        <Text style={[styles.small, styles.muted]}>
          {commonStrings[locale ?? 'en'].reference}: {reference}
        </Text>
      ) : null}
    </View>
  );
}

export function Loading({ locale }: { locale: Locale }) {
  return (
    <View style={styles.loading} accessibilityLabel={commonStrings[locale].loading}>
      <ActivityIndicator size="large" color={colors.brand} />
    </View>
  );
}

/** Reachable from every screen: never behind a form. */
export function EmergencyBar({ locale }: { locale: Locale }) {
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => void Linking.openURL('tel:112')}
      style={styles.emergency}
    >
      <Text style={styles.emergencyText}>{commonStrings[locale].emergency}</Text>
    </Pressable>
  );
}

export function Choice({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <Text style={[styles.body, selected && styles.choiceSelectedText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.md, gap: space.md },
  title: { fontSize: font.title, fontWeight: '700', color: colors.text },
  heading: { fontSize: font.large, fontWeight: '700', color: colors.text },
  body: { fontSize: font.body, color: colors.text, lineHeight: 22 },
  small: { fontSize: font.small },
  muted: { color: colors.muted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  button: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.sm,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.brand },
  danger: { backgroundColor: colors.danger },
  dim: { opacity: 0.6 },
  buttonText: { color: colors.onBrand, fontSize: font.body, fontWeight: '700' },
  secondaryText: { color: colors.brand },
  field: { gap: space.xs },
  label: { fontSize: font.small, fontWeight: '600', color: colors.text },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    fontSize: font.body,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  inputError: { borderColor: colors.danger },
  errorText: { color: colors.danger, fontSize: font.small },
  notice: { borderWidth: 1, borderRadius: radius.sm, padding: space.md, gap: space.xs },
  loading: { padding: space.xl, alignItems: 'center' },
  emergency: {
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.errorBackground,
    borderTopWidth: 1,
    borderColor: colors.danger,
  },
  emergencyText: { color: colors.danger, fontWeight: '700', fontSize: font.body },
  choice: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  choiceSelected: { borderColor: colors.brand, backgroundColor: colors.brand },
  choiceSelectedText: { color: colors.onBrand, fontWeight: '700' },
});
