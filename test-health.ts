import { ProviderHealthStore } from './packages/core/src/services/provider-health';

const store = new ProviderHealthStore();
console.log("Initial state:", store.getAllStates());
store.recordFailure('openai', 'gpt-4');
console.log("After 1 fail:", store.getAllStates());
store.recordFailure('openai', 'gpt-4');
console.log("After 2 fails:", store.getAllStates());
store.recordFailure('openai', 'gpt-4');
console.log("After 3 fails:", store.getAllStates());
