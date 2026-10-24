
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const API_URL = 'https://assess-beyond-data-v2.onrender.com';

const PLANS = [
  { code: 'BASIC_1_DAY', name: 'Basic · 1 Day', duration: '1 day', price: 1000 },
  { code: 'BASIC_3_DAYS', name: 'Basic · 3 Days', duration: '3 days', price: 3400 },
  { code: 'BASIC_7_DAYS', name: 'Basic · 7 Days', duration: '7 days', price: 6000 },
  { code: 'BASIC_30_DAYS', name: 'Basic · 30 Days', duration: '30 days', price: 25000 },
  { code: 'PREMIUM_1_DAY', name: 'Premium · 1 Day', duration: '1 day', price: 2000 },
  { code: 'PREMIUM_3_DAYS', name: 'Premium · 3 Days', duration: '3 days', price: 6000 },
  { code: 'PREMIUM_7_DAYS', name: 'Premium · 7 Days', duration: '7 days', price: 10000 },
  { code: 'PREMIUM_30_DAYS', name: 'Premium · 30 Days', duration: '30 days', price: 50000 },
];

async function requestJSON(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || `Request failed (${response.status}).`);
  }

  return data;
}

function showMessage(title, message) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(`${title}\n\n${message}`);
  } else {
    Alert.alert(title, message);
  }
}

export default function App() {
  const [email, setEmail] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('BASIC_1_DAY');
  const [loading, setLoading] = useState(false);
  const [serverStatus, setServerStatus] = useState('Checking connection…');
  const [paymentMessage, setPaymentMessage] = useState('');
const [activeSubscription, setActiveSubscription] = useState(null);
  const selected = PLANS.find((plan) => plan.code === selectedPlan);

  // Check that the Render backend is responding.
  useEffect(() => {
    let mounted = true;

    requestJSON('/')
      .then((data) => {
        if (mounted) {
          setServerStatus(
            data.status === 'running'
              ? 'Server connected'
              : 'Server responded'
          );
        }
      })
      .catch(() => {
        if (mounted) setServerStatus('Connection check failed');
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Verify a payment if the browser returns to this app with a reference.
  useEffect(() => {
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined'
    ) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const reference = params.get('reference');

    if (!reference || !/^[A-Za-z0-9_-]{1,100}$/.test(reference)) {
      return;
    }

    let cancelled = false;

    async function verifyReturnedPayment() {
      setLoading(true);
      setPaymentMessage('Checking your payment with ASSESS…');

      try {
        const result = await requestJSON(
          `/api/payments/verify/${encodeURIComponent(reference)}`
        );

        if (cancelled) return;

if (result.paid && result.activated) {
  setActiveSubscription({
    planCode: result.planCode || null,
    startsAt: result.startsAt || null,
    expiresAt: result.expiresAt || null,
    status: result.subscriptionStatus || 'active',
    deviceLimit: result.deviceLimit ?? 1,
    autoRenew: result.autoRenew ?? false,
  });

  setPaymentMessage(
    'Payment confirmed. Your ASSESS subscription is active.'
  );
}

         else {
          setPaymentMessage(
            result.message || 'Payment has not been confirmed yet.'
          );
        }
      } catch (error) {
        if (!cancelled) {
          setPaymentMessage(
            error.message ||
            'We could not verify the payment. Please check again.'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    verifyReturnedPayment();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePayment() {
    const cleanEmail = email.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      showMessage(
        'Check your email',
        'Enter a valid email address before continuing.'
      );
      return;
    }

    if (!selected) {
      showMessage('Select a plan', 'Please choose an ASSESS plan.');
      return;
    }

    setLoading(true);
    setPaymentMessage('');

    try {
      const data = await requestJSON('/api/payments/initialize', {
        method: 'POST',
        body: JSON.stringify({
          email: cleanEmail,
          planCode: selected.code,
        }),
      });

      const paymentUrl =
        data.authorization_url || data.data?.authorization_url;

      if (!paymentUrl) {
        throw new Error(
          'The server did not return a Paystack checkout link.'
        );
      }

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        // Open checkout in the current browser tab.
        window.location.assign(paymentUrl);
      } else {
        const canOpen = await Linking.canOpenURL(paymentUrl);

        if (!canOpen) {
          throw new Error(
            'Unable to open the payment link on this device.'
          );
        }

        await Linking.openURL(paymentUrl);
        setPaymentMessage(
          'Paystack opened. Return to ASSESS after checkout to check your payment.'
        );
      }
    } catch (error) {
      showMessage(
        'Unable to start payment',
        `${error.message}\n\nPlease check your connection and try again.`
      );
    } finally {
      setLoading(false);
    }
  }

  const basicPlans = PLANS.filter((plan) =>
    plan.code.startsWith('BASIC')
  );
  const premiumPlans = PLANS.filter((plan) =>
    plan.code.startsWith('PREMIUM')
  );

  function renderPlan(plan) {
    const isSelected = selectedPlan === plan.code;

    return (
      <TouchableOpacity
        key={plan.code}
        style={[
          styles.planCard,
          isSelected && styles.selectedCard,
        ]}
        onPress={() => setSelectedPlan(plan.code)}
        activeOpacity={0.8}
      >
        <View style={styles.planInfo}>
          <Text style={styles.planName}>{plan.name}</Text>
          <Text style={styles.planDescription}>
            {plan.duration} · 50GB daily high-speed allowance
          </Text>
        </View>

        <View style={styles.priceInfo}>
          <Text style={styles.price}>
            ₦{plan.price.toLocaleString('en-NG')}
          </Text>
          <Text style={styles.radio}>
            {isSelected ? '●' : '○'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#071426"
      />

      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.brand}>ASSESS</Text>
          <Text style={styles.tagline}>BEYOND DATA</Text>
          <Text style={styles.subtitle}>
            Reliable internet access, on your terms.
          </Text>
        </View>

        <View style={styles.statusBox}>
          <View
            style={[
              styles.statusDot,
              serverStatus === 'Server connected'
                ? styles.online
                : styles.offline,
            ]}
          />
          <Text style={styles.statusText}>{serverStatus}</Text>
        </View>

        <Text style={styles.heading}>Choose your plan</Text>
        <Text style={styles.description}>
          Select a duration that works for you. Both plans include
          a 50GB daily high-speed allowance, followed by reduced
          speed after the allowance is used.
        </Text>

        <Text style={styles.label}>Email address</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor="#7D8BA0"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />

        <Text style={styles.label}>Basic plans</Text>
        {basicPlans.map(renderPlan)}

        <Text style={styles.label}>Premium plans</Text>
        {premiumPlans.map(renderPlan)}

        <View style={styles.infoBox}>
          <Text style={styles.infoTitle}>Your ASSESS plan</Text>
          <Text style={styles.infoText}>
            • 50GB high-speed data allowance per day
          </Text>
          <Text style={styles.infoText}>
            • One device per subscription
          </Text>
          <Text style={styles.infoText}>
            • No automatic renewal
          </Text>
          <Text style={styles.infoText}>
            • Make a new payment when your plan expires
          </Text>
        </View>

{paymentMessage ? (
  <View style={styles.messageBox}>
    <Text style={styles.messageText}>
      {paymentMessage}
    </Text>
  </View>
) : null}

{activeSubscription ? (
  <View style={styles.messageBox}>
    <Text style={styles.messageText}>
      ACTIVE SUBSCRIPTION
    </Text>

    <Text style={styles.messageText}>
      Plan: {activeSubscription.planCode || 'Your ASSESS plan'}
    </Text>

    <Text style={styles.messageText}>
      Status: {activeSubscription.status}
    </Text>

    <Text style={styles.messageText}>
      Device limit: {activeSubscription.deviceLimit}
    </Text>

    <Text style={styles.messageText}>
      Expires: {activeSubscription.expiresAt
        ? new Date(activeSubscription.expiresAt).toLocaleString()
        : 'Not available'}
    </Text>

    <Text style={styles.messageText}>
      Auto-renewal: Off
    </Text>
  </View>
) : null}


const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#071426',
  },
  container: {
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 48,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  brand: {
    color: '#FFFFFF',
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: 5,
  },
  tagline: {
    color: '#43D9BD',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 5,
    marginTop: 4,
  },
  subtitle: {
    color: '#C5D0DF',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 14,
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#10233A',
    borderRadius: 10,
    padding: 12,
    marginBottom: 24,
  },
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginRight: 10,
  },
  online: {
    backgroundColor: '#43D9BD',
  },
  offline: {
    backgroundColor: '#F0B44D',
  },
  statusText: {
    color: '#DCE6F2',
    fontSize: 13,
  },
  heading: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 8,
  },
  description: {
    color: '#B6C4D6',
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 24,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#FFFFFF',
    color: '#071426',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    marginBottom: 8,
  },
  planCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#10233A',
    borderWidth: 1,
    borderColor: '#233B56',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  selectedCard: {
    borderColor: '#43D9BD',
    backgroundColor: '#123347',
  },
  planInfo: {
    flex: 1,
    paddingRight: 8,
  },
  planName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  planDescription: {
    color: '#B6C4D6',
    fontSize: 12,
    marginTop: 5,
  },
  priceInfo: {
    alignItems: 'flex-end',
  },
  price: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  radio: {
    color: '#43D9BD',
    fontSize: 18,
    marginTop: 4,
  },
  infoBox: {
    backgroundColor: '#10233A',
    borderRadius: 12,
    padding: 16,
    marginTop: 22,
  },
  infoTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 10,
  },
  infoText: {
    color: '#C5D0DF',
    fontSize: 13,
    lineHeight: 22,
  },
  messageBox: {
    backgroundColor: '#123347',
    borderColor: '#43D9BD',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginTop: 18,
  },
  messageText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 21,
  },
  payButton: {
    backgroundColor: '#43D9BD',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  disabledButton: {
    opacity: 0.6,
  },
  payButtonText: {
    color: '#071426',
    fontSize: 16,
    fontWeight: '900',
  },
  footer: {
    color: '#8496AD',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 18,
  },
});
