(() => {
  // node_modules/@simplewebauthn/browser/esm/helpers/bufferToBase64URLString.js
  function bufferToBase64URLString(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = "";
    for (const charCode of bytes) {
      str += String.fromCharCode(charCode);
    }
    const base64String = btoa(str);
    return base64String.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  // node_modules/@simplewebauthn/browser/esm/helpers/base64URLStringToBuffer.js
  function base64URLStringToBuffer(base64URLString) {
    const base64 = base64URLString.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = (4 - base64.length % 4) % 4;
    const padded = base64.padEnd(base64.length + padLength, "=");
    const binary = atob(padded);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return buffer;
  }

  // node_modules/@simplewebauthn/browser/esm/helpers/browserSupportsWebAuthn.js
  function browserSupportsWebAuthn() {
    return _browserSupportsWebAuthnInternals.stubThis(globalThis?.PublicKeyCredential !== void 0 && typeof globalThis.PublicKeyCredential === "function");
  }
  var _browserSupportsWebAuthnInternals = {
    stubThis: (value) => value
  };

  // node_modules/@simplewebauthn/browser/esm/helpers/toPublicKeyCredentialDescriptor.js
  function toPublicKeyCredentialDescriptor(descriptor) {
    const { id } = descriptor;
    return {
      ...descriptor,
      id: base64URLStringToBuffer(id),
      /**
       * `descriptor.transports` is an array of our `AuthenticatorTransportFuture` that includes newer
       * transports that TypeScript's DOM lib is ignorant of. Convince TS that our list of transports
       * are fine to pass to WebAuthn since browsers will recognize the new value.
       */
      transports: descriptor.transports
    };
  }

  // node_modules/@simplewebauthn/browser/esm/helpers/isValidDomain.js
  function isValidDomain(hostname) {
    return (
      // Consider localhost valid as well since it's okay wrt Secure Contexts
      hostname === "localhost" || // Support punycode (ACE) or ascii labels and domains
      /^((xn--[a-z0-9-]+|[a-z0-9]+(-[a-z0-9]+)*)\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/i.test(hostname)
    );
  }

  // node_modules/@simplewebauthn/browser/esm/helpers/webAuthnError.js
  var WebAuthnError = class extends Error {
    constructor({ message, code, cause, name }) {
      super(message, { cause });
      Object.defineProperty(this, "code", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
      this.name = name ?? cause.name;
      this.code = code;
    }
  };

  // node_modules/@simplewebauthn/browser/esm/helpers/identifyRegistrationError.js
  function identifyRegistrationError({ error, options }) {
    const { publicKey } = options;
    if (!publicKey) {
      throw Error("options was missing required publicKey property");
    }
    if (error.name === "AbortError") {
      if (options.signal instanceof AbortSignal) {
        return new WebAuthnError({
          message: "Registration ceremony was sent an abort signal",
          code: "ERROR_CEREMONY_ABORTED",
          cause: error
        });
      }
    } else if (error.name === "ConstraintError") {
      if (publicKey.authenticatorSelection?.requireResidentKey === true) {
        return new WebAuthnError({
          message: "Discoverable credentials were required but no available authenticator supported it",
          code: "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT",
          cause: error
        });
      } else if (
        // @ts-ignore: `mediation` doesn't yet exist on CredentialCreationOptions but it's possible as of Sept 2024
        options.mediation === "conditional" && publicKey.authenticatorSelection?.userVerification === "required"
      ) {
        return new WebAuthnError({
          message: "User verification was required during automatic registration but it could not be performed",
          code: "ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE",
          cause: error
        });
      } else if (publicKey.authenticatorSelection?.userVerification === "required") {
        return new WebAuthnError({
          message: "User verification was required but no available authenticator supported it",
          code: "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT",
          cause: error
        });
      }
    } else if (error.name === "InvalidStateError") {
      return new WebAuthnError({
        message: "The authenticator was previously registered",
        code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
        cause: error
      });
    } else if (error.name === "NotAllowedError") {
      return new WebAuthnError({
        message: error.message,
        code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
        cause: error
      });
    } else if (error.name === "NotSupportedError") {
      const validPubKeyCredParams = publicKey.pubKeyCredParams.filter((param) => param.type === "public-key");
      if (validPubKeyCredParams.length === 0) {
        return new WebAuthnError({
          message: 'No entry in pubKeyCredParams was of type "public-key"',
          code: "ERROR_MALFORMED_PUBKEYCREDPARAMS",
          cause: error
        });
      }
      return new WebAuthnError({
        message: "No available authenticator supported any of the specified pubKeyCredParams algorithms",
        code: "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG",
        cause: error
      });
    } else if (error.name === "SecurityError") {
      const effectiveDomain = globalThis.location.hostname;
      if (!isValidDomain(effectiveDomain)) {
        return new WebAuthnError({
          message: `${globalThis.location.hostname} is an invalid domain`,
          code: "ERROR_INVALID_DOMAIN",
          cause: error
        });
      } else if (publicKey.rp.id !== effectiveDomain) {
        return new WebAuthnError({
          message: `The RP ID "${publicKey.rp.id}" is invalid for this domain`,
          code: "ERROR_INVALID_RP_ID",
          cause: error
        });
      }
    } else if (error.name === "TypeError") {
      if (publicKey.user.id.byteLength < 1 || publicKey.user.id.byteLength > 64) {
        return new WebAuthnError({
          message: "User ID was not between 1 and 64 characters",
          code: "ERROR_INVALID_USER_ID_LENGTH",
          cause: error
        });
      }
    } else if (error.name === "UnknownError") {
      return new WebAuthnError({
        message: "The authenticator was unable to process the specified options, or could not create a new credential",
        code: "ERROR_AUTHENTICATOR_GENERAL_ERROR",
        cause: error
      });
    }
    return error;
  }

  // node_modules/@simplewebauthn/browser/esm/helpers/webAuthnAbortService.js
  var BaseWebAuthnAbortService = class {
    constructor() {
      Object.defineProperty(this, "controller", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: void 0
      });
    }
    createNewAbortSignal() {
      if (this.controller) {
        const abortError = new Error("Cancelling existing WebAuthn API call for new one");
        abortError.name = "AbortError";
        this.controller.abort(abortError);
      }
      const newController = new AbortController();
      this.controller = newController;
      return newController.signal;
    }
    cancelCeremony() {
      if (this.controller) {
        const abortError = new Error("Manually cancelling existing WebAuthn API call");
        abortError.name = "AbortError";
        this.controller.abort(abortError);
        this.controller = void 0;
      }
    }
  };
  var WebAuthnAbortService = new BaseWebAuthnAbortService();

  // node_modules/@simplewebauthn/browser/esm/helpers/toAuthenticatorAttachment.js
  var attachments = ["cross-platform", "platform"];
  function toAuthenticatorAttachment(attachment) {
    if (!attachment) {
      return;
    }
    if (attachments.indexOf(attachment) < 0) {
      return;
    }
    return attachment;
  }

  // node_modules/@simplewebauthn/browser/esm/methods/startRegistration.js
  async function startRegistration(options) {
    if (!options.optionsJSON && options.challenge) {
      console.warn("startRegistration() was not called correctly. It will try to continue with the provided options, but this call should be refactored to use the expected call structure instead. See https://simplewebauthn.dev/docs/packages/browser#typeerror-cannot-read-properties-of-undefined-reading-challenge for more information.");
      options = { optionsJSON: options };
    }
    const { optionsJSON, useAutoRegister = false } = options;
    if (!browserSupportsWebAuthn()) {
      throw new Error("WebAuthn is not supported in this browser");
    }
    const publicKey = {
      ...optionsJSON,
      challenge: base64URLStringToBuffer(optionsJSON.challenge),
      user: {
        ...optionsJSON.user,
        id: base64URLStringToBuffer(optionsJSON.user.id)
      },
      excludeCredentials: optionsJSON.excludeCredentials?.map(toPublicKeyCredentialDescriptor)
    };
    const createOptions = {};
    if (useAutoRegister) {
      createOptions.mediation = "conditional";
    }
    createOptions.publicKey = publicKey;
    createOptions.signal = WebAuthnAbortService.createNewAbortSignal();
    let credential;
    try {
      credential = await navigator.credentials.create(createOptions);
    } catch (err) {
      throw identifyRegistrationError({ error: err, options: createOptions });
    }
    if (!credential) {
      throw new Error("Registration was not completed");
    }
    const { id, rawId, response, type } = credential;
    let transports = void 0;
    if (typeof response.getTransports === "function") {
      transports = response.getTransports();
    }
    let responsePublicKeyAlgorithm = void 0;
    if (typeof response.getPublicKeyAlgorithm === "function") {
      try {
        responsePublicKeyAlgorithm = response.getPublicKeyAlgorithm();
      } catch (error) {
        warnOnBrokenImplementation("getPublicKeyAlgorithm()", error);
      }
    }
    let responsePublicKey = void 0;
    if (typeof response.getPublicKey === "function") {
      try {
        const _publicKey = response.getPublicKey();
        if (_publicKey !== null) {
          responsePublicKey = bufferToBase64URLString(_publicKey);
        }
      } catch (error) {
        warnOnBrokenImplementation("getPublicKey()", error);
      }
    }
    let responseAuthenticatorData;
    if (typeof response.getAuthenticatorData === "function") {
      try {
        responseAuthenticatorData = bufferToBase64URLString(response.getAuthenticatorData());
      } catch (error) {
        warnOnBrokenImplementation("getAuthenticatorData()", error);
      }
    }
    return {
      id,
      rawId: bufferToBase64URLString(rawId),
      response: {
        attestationObject: bufferToBase64URLString(response.attestationObject),
        clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
        transports,
        publicKeyAlgorithm: responsePublicKeyAlgorithm,
        publicKey: responsePublicKey,
        authenticatorData: responseAuthenticatorData
      },
      type,
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: toAuthenticatorAttachment(credential.authenticatorAttachment)
    };
  }
  function warnOnBrokenImplementation(methodName, cause) {
    console.warn(`The browser extension that intercepted this WebAuthn API call incorrectly implemented ${methodName}. You should report this error to them.
`, cause);
  }

  // node_modules/@simplewebauthn/browser/esm/helpers/browserSupportsWebAuthnAutofill.js
  function browserSupportsWebAuthnAutofill() {
    if (!browserSupportsWebAuthn()) {
      return _browserSupportsWebAuthnAutofillInternals.stubThis(new Promise((resolve) => resolve(false)));
    }
    const globalPublicKeyCredential = globalThis.PublicKeyCredential;
    if (globalPublicKeyCredential?.isConditionalMediationAvailable === void 0) {
      return _browserSupportsWebAuthnAutofillInternals.stubThis(new Promise((resolve) => resolve(false)));
    }
    return _browserSupportsWebAuthnAutofillInternals.stubThis(globalPublicKeyCredential.isConditionalMediationAvailable());
  }
  var _browserSupportsWebAuthnAutofillInternals = {
    stubThis: (value) => value
  };

  // node_modules/@simplewebauthn/browser/esm/helpers/identifyAuthenticationError.js
  function identifyAuthenticationError({ error, options }) {
    const { publicKey } = options;
    if (!publicKey) {
      throw Error("options was missing required publicKey property");
    }
    if (error.name === "AbortError") {
      if (options.signal instanceof AbortSignal) {
        return new WebAuthnError({
          message: "Authentication ceremony was sent an abort signal",
          code: "ERROR_CEREMONY_ABORTED",
          cause: error
        });
      }
    } else if (error.name === "NotAllowedError") {
      return new WebAuthnError({
        message: error.message,
        code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
        cause: error
      });
    } else if (error.name === "SecurityError") {
      const effectiveDomain = globalThis.location.hostname;
      if (!isValidDomain(effectiveDomain)) {
        return new WebAuthnError({
          message: `${globalThis.location.hostname} is an invalid domain`,
          code: "ERROR_INVALID_DOMAIN",
          cause: error
        });
      } else if (publicKey.rpId !== effectiveDomain) {
        return new WebAuthnError({
          message: `The RP ID "${publicKey.rpId}" is invalid for this domain`,
          code: "ERROR_INVALID_RP_ID",
          cause: error
        });
      }
    } else if (error.name === "UnknownError") {
      return new WebAuthnError({
        message: "The authenticator was unable to process the specified options, or could not create a new assertion signature",
        code: "ERROR_AUTHENTICATOR_GENERAL_ERROR",
        cause: error
      });
    }
    return error;
  }

  // node_modules/@simplewebauthn/browser/esm/methods/startAuthentication.js
  async function startAuthentication(options) {
    if (!options.optionsJSON && options.challenge) {
      console.warn("startAuthentication() was not called correctly. It will try to continue with the provided options, but this call should be refactored to use the expected call structure instead. See https://simplewebauthn.dev/docs/packages/browser#typeerror-cannot-read-properties-of-undefined-reading-challenge for more information.");
      options = { optionsJSON: options };
    }
    const { optionsJSON, useBrowserAutofill = false, verifyBrowserAutofillInput = true } = options;
    if (!browserSupportsWebAuthn()) {
      throw new Error("WebAuthn is not supported in this browser");
    }
    let allowCredentials;
    if (optionsJSON.allowCredentials?.length !== 0) {
      allowCredentials = optionsJSON.allowCredentials?.map(toPublicKeyCredentialDescriptor);
    }
    const publicKey = {
      ...optionsJSON,
      challenge: base64URLStringToBuffer(optionsJSON.challenge),
      allowCredentials
    };
    const getOptions = {};
    if (useBrowserAutofill) {
      if (!await browserSupportsWebAuthnAutofill()) {
        throw Error("Browser does not support WebAuthn autofill");
      }
      const eligibleInputs = document.querySelectorAll("input[autocomplete$='webauthn']");
      if (eligibleInputs.length < 1 && verifyBrowserAutofillInput) {
        throw Error('No <input> with "webauthn" as the only or last value in its `autocomplete` attribute was detected');
      }
      getOptions.mediation = "conditional";
      publicKey.allowCredentials = [];
    }
    getOptions.publicKey = publicKey;
    getOptions.signal = WebAuthnAbortService.createNewAbortSignal();
    let credential;
    try {
      credential = await navigator.credentials.get(getOptions);
    } catch (err) {
      throw identifyAuthenticationError({ error: err, options: getOptions });
    }
    if (!credential) {
      throw new Error("Authentication was not completed");
    }
    const { id, rawId, response, type } = credential;
    let userHandle = void 0;
    if (response.userHandle) {
      userHandle = bufferToBase64URLString(response.userHandle);
    }
    return {
      id,
      rawId: bufferToBase64URLString(rawId),
      response: {
        authenticatorData: bufferToBase64URLString(response.authenticatorData),
        clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
        signature: bufferToBase64URLString(response.signature),
        userHandle
      },
      type,
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: toAuthenticatorAttachment(credential.authenticatorAttachment)
    };
  }

  // client/passkey-entry.js
  var $ = (id) => document.getElementById(id);
  async function request(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers ?? {} },
      cache: "no-store"
    });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `\u8BF7\u6C42\u5931\u8D25\uFF08${response.status}\uFF09`);
    return body;
  }
  function showError(error) {
    const box = $("error");
    if (!box) return;
    box.textContent = error?.message || String(error);
    box.hidden = false;
  }
  function setBusy(button, busy, text) {
    if (!button) return;
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? text : button.dataset.idleText;
  }
  async function login() {
    const button = $("login-button");
    try {
      setBusy(button, true, "\u7B49\u5F85\u624B\u673A\u786E\u8BA4\u2026");
      const { requestId, options } = await request("/pocket-auth/options");
      const response = await startAuthentication({ optionsJSON: options });
      const result = await request("/pocket-auth/verify", {
        method: "POST",
        body: JSON.stringify({ requestId, response })
      });
      location.replace(result.redirect || "/");
    } catch (error) {
      showError(error);
      setBusy(button, false, "");
    }
  }
  async function pair(event) {
    event.preventDefault();
    const button = $("pair-button");
    const name = String($("device-name")?.value ?? "").trim();
    const token = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (!token) return showError(new Error("\u914D\u5BF9\u94FE\u63A5\u65E0\u6548\u6216\u5DF2\u7ECF\u5931\u6548"));
    if (!name) return showError(new Error("\u8BF7\u586B\u5199\u8BBE\u5907\u540D\u79F0"));
    try {
      setBusy(button, true, "\u7B49\u5F85\u624B\u673A\u786E\u8BA4\u2026");
      const { options } = await request("/pocket-pair/options", {
        method: "POST",
        body: JSON.stringify({ token, name })
      });
      const response = await startRegistration({ optionsJSON: options });
      await request("/pocket-pair/verify", {
        method: "POST",
        body: JSON.stringify({ token, response })
      });
      $("pair-form").hidden = true;
      $("pair-complete").hidden = false;
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch (error) {
      showError(error);
      setBusy(button, false, "");
    }
  }
  function boot() {
    if (!browserSupportsWebAuthn()) {
      showError(new Error("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u624B\u673A\u8EAB\u4EFD\u9A8C\u8BC1\uFF0C\u8BF7\u4F7F\u7528\u6700\u65B0\u7248 Safari\u3001Chrome \u6216 Edge"));
      document.querySelectorAll("button").forEach((button) => {
        button.disabled = true;
      });
      return;
    }
    $("login-button")?.addEventListener("click", login);
    $("pair-form")?.addEventListener("submit", pair);
  }
  document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
