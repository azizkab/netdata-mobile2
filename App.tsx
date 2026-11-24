import React, { useEffect } from 'react';
import { PermissionsAndroid, Permission, Platform } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { saveDeviceInfo } from './src/database/db';
import { startCollector } from './src/services/collector';

const requestPermissions = async () => {
  const permissions: Permission[] = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  ];
  if (Number(Platform.Version) >= 33) {
    permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  await PermissionsAndroid.requestMultiple(permissions);
};

export default function App() {
  useEffect(() => {
    const init = async () => {
      try {
        await requestPermissions();
        await saveDeviceInfo();
      } catch (e) {
        console.warn('Initialisation :', e);
      }
      startCollector();
    };
    init();
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}