import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import DashboardScreen from '../screens/DashboardScreen';
import SecurityScreen from '../screens/SecurityScreen';
import NetworkScreen from '../screens/NetworkScreen';
import MapScreen from '../screens/MapScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function AppNavigator() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Tableau de bord' }} />
      <Tab.Screen name="Security" component={SecurityScreen} options={{ title: 'Sécurité' }} />
      <Tab.Screen name="Network" component={NetworkScreen} options={{ title: 'Réseau' }} />
      <Tab.Screen name="Map" component={MapScreen} options={{ title: 'Carte' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: 'Paramètres' }} />
    </Tab.Navigator>
  );
}  