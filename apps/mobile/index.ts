// Must be first: polyfills crypto.getRandomValues for tweetnacl (keypair +
// nonce generation) and our id helper. Without it the handshake throws.
import "react-native-get-random-values";
import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);
