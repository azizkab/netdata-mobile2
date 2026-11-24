/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { backgroundTask } from './src/services/collector';

AppRegistry.registerComponent(appName, () => App);

// Tâche exécutée par le service Android CollectorService (collecte en arrière-plan)
AppRegistry.registerHeadlessTask('NetdataCollector', () => backgroundTask);