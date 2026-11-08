/**
 * ============================================================================
 * APLICACIÓN FRONT-END DE PRODUCCIÓN - BEESENSE IoT (2026)
 * ============================================================================
 * Contenedor estático optimizado para Amazon S3 + Amazon CloudFront (HTTPS).
 * Integración nativa con:
 *   - Amazon Cognito (Autenticación OAuth 2.0 / OIDC / User Pool JWT)
 *   - AWS IoT Core (WebSockets WSS en Tiempo Real)
 *   - Amazon API Gateway -> AWS Lambda -> Amazon DynamoDB (REST Histórico y Eventos)
 */
(function () {
  'use strict';

  const { useState, useEffect, useRef, useMemo, useCallback, Fragment } = React;
  const h = React.createElement;

  const SESSION_ID_TOKEN_KEY = 'beesense_cognito_id_token';
  const SESSION_ACCESS_TOKEN_KEY = 'beesense_cognito_access_token';
  const LOCAL_STORAGE_EVENTS_KEY = 'beesense_dynamodb_events_v1';
  const SEEN_EVENTS_KEY = 'beesense_seen_event_ids_v1';
  const VALID_HASH_ROUTES = ['', '#', '#/', '#/login', '#/dashboard', '#/reportes', '#/meteorologia', '#/cuenta'];

  /* ==========================================================================
     1. CONFIGURACIÓN CLOUD Y AUTENTICACIÓN JWT (AMAZON COGNITO)
     ========================================================================== */
  function getRuntimeConfig() {
    const cfg = (typeof window !== 'undefined' && window.BEESENSE_CONFIG) || {};
    const apiBaseUrl = String(cfg.API_BASE_URL || '').replace(/\/+$/, '');
    const defaultRedirect =
      typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';

    return {
      productionMode: cfg.PRODUCTION_MODE !== undefined ? Boolean(cfg.PRODUCTION_MODE) : true,
      enableSimulator: Boolean(cfg.ENABLE_SIMULATOR),
      apiBaseUrl,
      telemetryRoute: cfg.TELEMETRY_ROUTE || '/telemetry',
      singleRouteMode: cfg.SINGLE_ROUTE_MODE !== undefined ? Boolean(cfg.SINGLE_ROUTE_MODE) : true,
      pollingIntervalMs: Number(cfg.POLLING_INTERVAL_MS) || 5000,
      colmenarId: cfg.COLMENAR_ID || 'Hive_001',
      nombreColmenar: cfg.NOMBRE_COLMENAR || 'Colmenar Principal - Sede PAO',
      batteryAlertThreshold:
        cfg.BATTERY_ALERT_THRESHOLD !== undefined ? Number(cfg.BATTERY_ALERT_THRESHOLD) : 10,
      deviceOfflineThresholdSeconds:
        Number(cfg.DEVICE_OFFLINE_THRESHOLD_SECONDS) ||
        Number(cfg.DEVICE_TIMEOUT_SECONDS) ||
        60,
      smsBridgeUrl: cfg.SMS_BRIDGE_URL || '',
      cognito: {
        enabled: Boolean(cfg.COGNITO && cfg.COGNITO.ENABLED),
        domain: String((cfg.COGNITO && cfg.COGNITO.DOMAIN) || '')
          .replace(/^https?:\/\//, '')
          .replace(/\/+$/, ''),
        clientId: String((cfg.COGNITO && cfg.COGNITO.CLIENT_ID) || '').trim(),
        userPoolId: String((cfg.COGNITO && cfg.COGNITO.USER_POOL_ID) || '').trim(),
        authority: String((cfg.COGNITO && cfg.COGNITO.AUTHORITY) || '').trim(),
        redirectUri: (cfg.COGNITO && cfg.COGNITO.REDIRECT_URI) || defaultRedirect,
        logoutUri: (cfg.COGNITO && cfg.COGNITO.LOGOUT_URI) || defaultRedirect,
        responseType: (cfg.COGNITO && cfg.COGNITO.RESPONSE_TYPE) || 'code',
        identityProvider:
          cfg.COGNITO && cfg.COGNITO.IDENTITY_PROVIDER !== undefined
            ? cfg.COGNITO.IDENTITY_PROVIDER
            : '',
        scope: (cfg.COGNITO && cfg.COGNITO.SCOPE) || 'email openid profile',
      },
      iotWss: {
        enabled: Boolean(cfg.IOT_WSS && cfg.IOT_WSS.ENABLED),
        wssUrl: String((cfg.IOT_WSS && cfg.IOT_WSS.WSS_URL) || '').trim(),
        usePresignedEndpoint: Boolean(cfg.IOT_WSS && cfg.IOT_WSS.USE_PRESIGNED_ENDPOINT),
        mqttTopic:
          (cfg.IOT_WSS && cfg.IOT_WSS.MQTT_TOPIC) || 'beesense/COLMENAR-NORTE-01/telemetria',
      },
    };
  }

  function decodeJwtPayload(jwtToken) {
    if (!jwtToken || typeof jwtToken !== 'string') return null;
    try {
      const parts = jwtToken.split('.');
      if (parts.length < 2) return null;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = decodeURIComponent(
        atob(base64)
          .split('')
          .map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          })
          .join('')
      );
      return JSON.parse(jsonStr);
    } catch (e) {
      return null;
    }
  }

  function isOAuthHash(hashStr) {
    const str = hashStr || '';
    return (
      str.indexOf('id_token=') !== -1 ||
      str.indexOf('access_token=') !== -1 ||
      str.indexOf('error_description=') !== -1
    );
  }

  function consumeCognitoCallbackFromUrl() {
    if (typeof window === 'undefined') return null;
    const hash = window.location.hash || '';
    if (!isOAuthHash(hash)) return null;

    const params = new URLSearchParams(hash.replace(/^#\/?/, ''));
    const idToken = params.get('id_token');
    const accessToken = params.get('access_token');

    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    const primaryToken = idToken || accessToken;
    if (!primaryToken) return null;

    try {
      if (idToken) sessionStorage.setItem(SESSION_ID_TOKEN_KEY, idToken);
      if (accessToken) sessionStorage.setItem(SESSION_ACCESS_TOKEN_KEY, accessToken);
    } catch (e) {}

    const claims = decodeJwtPayload(primaryToken);
    return {
      token: primaryToken,
      user: claims
        ? {
            id: claims.sub || '15797764717598643303',
            name: claims.name || claims['cognito:username'] || claims.email || 'Apicultor',
            email: claims.email || '',
          }
        : null,
    };
  }

  function getStoredCognitoSession() {
    if (typeof window === 'undefined') return null;
    try {
      const token =
        sessionStorage.getItem(SESSION_ID_TOKEN_KEY) ||
        sessionStorage.getItem(SESSION_ACCESS_TOKEN_KEY);
      if (!token) return null;

      const claims = decodeJwtPayload(token);
      if (claims && claims.exp && Date.now() >= claims.exp * 1000) {
        sessionStorage.removeItem(SESSION_ID_TOKEN_KEY);
        sessionStorage.removeItem(SESSION_ACCESS_TOKEN_KEY);
        return null;
      }

      return {
        token,
        user: claims
          ? {
              id: claims.sub || '15797764717598643303',
              name: claims.name || claims['cognito:username'] || claims.email || 'Apicultor',
              email: claims.email || '',
            }
          : null,
      };
    } catch (e) {
      return null;
    }
  }

  function generateRandomPkceVerifier(length) {
    const len = length || 64;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let res = '';
    if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
      const vals = new Uint8Array(len);
      window.crypto.getRandomValues(vals);
      for (let i = 0; i < len; i++) {
        res += chars[vals[i] % chars.length];
      }
    } else {
      for (let i = 0; i < len; i++) {
        res += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    }
    return res;
  }

  async function generatePkceChallenge(verifier) {
    if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) return null;
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  async function buildCognitoAuthorizeUrlAsync() {
    const cognito = getRuntimeConfig().cognito;
    if (!cognito.enabled || !cognito.domain || !cognito.clientId) return null;
    const responseType = cognito.responseType || 'code';
    const params = new URLSearchParams({
      client_id: cognito.clientId,
      response_type: responseType,
      scope: cognito.scope,
      redirect_uri: cognito.redirectUri,
      lang: 'es',
      locale: 'es',
      ui_locales: 'es',
    });
    if (cognito.identityProvider && cognito.identityProvider.trim()) {
      params.set('identity_provider', cognito.identityProvider.trim());
    }

    if (responseType === 'code') {
      try {
        const verifier = generateRandomPkceVerifier(64);
        sessionStorage.setItem('beesense_cognito_pkce_verifier', verifier);
        const challenge = await generatePkceChallenge(verifier);
        if (challenge) {
          params.set('code_challenge', challenge);
          params.set('code_challenge_method', 'S256');
        }
      } catch (e) {
        console.warn('PKCE challenge generation omitted:', e);
      }
    }
    return 'https://' + cognito.domain + '/oauth2/authorize?' + params.toString();
  }

  function buildCognitoAuthorizeUrl() {
    const cognito = getRuntimeConfig().cognito;
    if (!cognito.enabled || !cognito.domain || !cognito.clientId) return null;
    const responseType = cognito.responseType || 'code';
    const params = new URLSearchParams({
      client_id: cognito.clientId,
      response_type: responseType,
      scope: cognito.scope,
      redirect_uri: cognito.redirectUri,
      lang: 'es',
      locale: 'es',
      ui_locales: 'es',
    });
    if (cognito.identityProvider && cognito.identityProvider.trim()) {
      params.set('identity_provider', cognito.identityProvider.trim());
    }
    return 'https://' + cognito.domain + '/oauth2/authorize?' + params.toString();
  }

  async function exchangeCognitoCodeForTokens(code) {
    const cognito = getRuntimeConfig().cognito;
    if (!cognito.enabled || !cognito.domain || !cognito.clientId || !code) return null;
    const tokenUrl = 'https://' + cognito.domain + '/oauth2/token';
    const bodyParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cognito.clientId,
      redirect_uri: cognito.redirectUri,
      code: code,
    });

    try {
      const verifier = sessionStorage.getItem('beesense_cognito_pkce_verifier');
      if (verifier) {
        bodyParams.set('code_verifier', verifier);
      }
    } catch (e) {}

    try {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
      });

      try {
        sessionStorage.removeItem('beesense_cognito_pkce_verifier');
      } catch (e) {}

      if (!res.ok) {
        console.warn('Cognito token exchange response status:', res.status);
        return null;
      }

      const data = await res.json();
      const idToken = data.id_token;
      const accessToken = data.access_token;
      const primaryToken = idToken || accessToken;
      if (!primaryToken) return null;

      try {
        if (idToken) sessionStorage.setItem(SESSION_ID_TOKEN_KEY, idToken);
        if (accessToken) sessionStorage.setItem(SESSION_ACCESS_TOKEN_KEY, accessToken);
        if (data.refresh_token) {
          sessionStorage.setItem('beesense_cognito_refresh_token', data.refresh_token);
        }
      } catch (e) {}

      const claims = decodeJwtPayload(primaryToken);
      return {
        token: primaryToken,
        user: claims
          ? {
              id: claims.sub || '15797764717598643303',
              name: claims.name || claims['cognito:username'] || claims.email || 'Apicultor',
              email: claims.email || '',
            }
          : null,
      };
    } catch (err) {
      console.warn('Error fetching Cognito tokens:', err);
      return null;
    }
  }

  function clearCognitoSession() {
    try {
      sessionStorage.removeItem(SESSION_ID_TOKEN_KEY);
      sessionStorage.removeItem(SESSION_ACCESS_TOKEN_KEY);
      sessionStorage.removeItem('beesense_cognito_refresh_token');
      sessionStorage.removeItem('beesense_cognito_pkce_verifier');
    } catch (e) {}
    const cognito = getRuntimeConfig().cognito;
    if (cognito.enabled && cognito.domain && cognito.clientId) {
      const clientId = cognito.clientId;
      const logoutUri = cognito.logoutUri;
      return (
        'https://' +
        cognito.domain +
        '/logout?client_id=' +
        encodeURIComponent(clientId) +
        '&logout_uri=' +
        encodeURIComponent(logoutUri)
      );
    }
    return null;
  }

  let resolvedActiveRoute = null;

  function getEffectiveTelemetryRoute(cfg) {
    if (resolvedActiveRoute) return resolvedActiveRoute;
    const r = cfg.telemetryRoute || '/telemetry';
    return r.charAt(0) === '/' ? r : '/' + r;
  }

  function buildApiHeaders(method) {
    const m = String(method || 'GET').toUpperCase();
    const headers = {};
    const session = getStoredCognitoSession();
    if (session && session.token) {
      headers.Authorization = 'Bearer ' + session.token;
    }
    // En GET u operaciones Simple Request evitamos Content-Type: application/json
    // para NO disparar preflight OPTIONS en API Gateway cuando no es necesario.
    if (m !== 'GET' && m !== 'HEAD') {
      headers['Content-Type'] =
        session && session.token ? 'application/json' : 'text/plain;charset=UTF-8';
    }
    return headers;
  }

  /* ==========================================================================
     2. UTILIDADES DE FECHA, SERIES TELEMÉTRICAS Y COMUNICACIÓN AWS
     ========================================================================== */
  function formatDateTimeCL(dateInput) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
    if (Number.isNaN(d.getTime())) return String(dateInput);
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    const hours24 = d.getHours();
    const period = hours24 >= 12 ? 'p. m.' : 'a. m.';
    const hours12 = hours24 % 12 || 12;
    return (
      pad(d.getDate()) +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      d.getFullYear() +
      ', ' +
      hours12 +
      ':' +
      pad(d.getMinutes()) +
      ':' +
      pad(d.getSeconds()) +
      ' ' +
      period
    );
  }

  function toISODateString(dateInput) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function toTimeHHMM24(dateInput) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
    if (Number.isNaN(d.getTime())) return '';
    const pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function getEventTimeHHMM(ev) {
    if (ev.horaInicio24) return ev.horaInicio24;
    if (ev.fechaInicio) {
      const m = String(ev.fechaInicio).match(/(\d{1,2}):(\d{2}):\d{2}\s*(a\.\s*m\.|p\.\s*m\.)?/i);
      if (m) {
        let hrs = parseInt(m[1], 10);
        const mins = m[2];
        const per = (m[3] || '').toLowerCase();
        if (per.indexOf('p') !== -1 && hrs < 12) hrs += 12;
        if (per.indexOf('a') !== -1 && hrs === 12) hrs = 0;
        return String(hrs).padStart(2, '0') + ':' + mins;
      }
    }
    return '00:00';
  }

  function buildHourlySeries(baseTempInt, baseTempExt, flatLine) {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const points = [];
    for (let i = 9; i >= 0; i--) {
      const t = new Date(now.getTime() - i * 60 * 60 * 1000);
      const label = String(t.getHours()).padStart(2, '0') + ':00';
      const wave = flatLine ? 0 : Math.sin(i * 0.65) * 0.4;
      points.push({
        time: label,
        timestamp: t.toISOString(),
        interior:
          baseTempInt !== null && baseTempInt !== undefined
            ? Number(((Number(baseTempInt) || 0) + wave).toFixed(1))
            : null,
        exterior:
          baseTempExt !== null && baseTempExt !== undefined
            ? Number(((Number(baseTempExt) || 0) + wave * 0.7).toFixed(1))
            : null,
      });
    }
    return points;
  }
  const buildTenMinuteSeries = buildHourlySeries;

  const TELEMETRY_KNOWN_KEYS = [
    'temperatura_interior_c',
    'tempInterior',
    'temperatura_exterior_c',
    'tempExterior',
    'humedad_exterior_pct',
    'humedadExterior',
    'tapa_abierta',
    'estadoTapa',
    'bateria_porcentaje_estimado',
    'bateria',
    'bateria_lectura_valida',
    'bateria_voltaje_v',
    'temperatura_interior_valida',
    'tapa_lectura_valida',
    'evento',
    'timestamp_unix',
  ];

  const LEGACY_SEED_CUTOFF_MS = 1793000000000;

  function isLegacySeedEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const id = String(ev.id || '');
    if (id.indexOf('EVT-NA-1728') === 0 || id.indexOf('EVT-NA-1791') === 0) return true;
    const startMs = Number(ev.startTimestampMs || 0);
    if (id.indexOf('EVT-NA-') === 0 && startMs > 0 && startMs < LEGACY_SEED_CUTOFF_MS) return true;
    return false;
  }

  function unwrapDynamoRecord(rawObj) {
    if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) return rawObj;
    let obj = rawObj;
    if (typeof obj.body === 'string') {
      try {
        const parsedBody = JSON.parse(obj.body);
        if (parsedBody && typeof parsedBody === 'object') obj = parsedBody;
      } catch (e) {}
    }
    const out = {};
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const val = obj[k];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const subKeys = Object.keys(val);
        if ('N' in val && subKeys.length === 1) out[k] = Number(val.N);
        else if ('S' in val && subKeys.length === 1) out[k] = String(val.S);
        else if ('BOOL' in val && subKeys.length === 1) out[k] = Boolean(val.BOOL);
        else if ('NULL' in val && val.NULL) out[k] = null;
        else out[k] = val;
      } else {
        out[k] = val;
      }
    }
    return out;
  }

  function parseFlexibleTimestamp(rawTs) {
    if (rawTs === null || rawTs === undefined || rawTs === '') {
      return { date: null, iso: null, ms: null };
    }
    if (
      typeof rawTs === 'number' ||
      (typeof rawTs === 'string' && /^\d+(\.\d+)?$/.test(rawTs.trim()))
    ) {
      const num = Number(rawTs);
      const ms = num > 0 && num < 1e12 ? Math.round(num * 1000) : Math.round(num);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) {
        return { date: d, iso: d.toISOString(), ms: d.getTime() };
      }
    }
    const d = new Date(rawTs);
    if (!Number.isNaN(d.getTime())) {
      return { date: d, iso: d.toISOString(), ms: d.getTime() };
    }
    return { date: null, iso: null, ms: null };
  }

  function parseSensorNumber(val, minValid, maxValid, validFlag) {
    if (validFlag === false || String(validFlag).toLowerCase() === 'false') return null;
    if (
      val === null ||
      val === undefined ||
      val === '' ||
      String(val).toUpperCase() === 'N/A' ||
      String(val).toLowerCase() === 'nan'
    ) {
      return null;
    }
    const n = Number(val);
    if (Number.isNaN(n) || !Number.isFinite(n)) return null;
    if (minValid !== undefined && n < minValid) return null;
    if (maxValid !== undefined && n > maxValid) return null;
    return n;
  }

  function normalizeTelemetryPayload(rawInput) {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
    const raw = unwrapDynamoRecord(rawInput);
    if (
      ('peso_kg' in raw || 'temperatura_interna' in raw) &&
      !('temperatura_interior_c' in raw) &&
      !('evento' in raw) &&
      !('timestamp_unix' in raw) &&
      !('bateria_lectura_valida' in raw)
    ) {
      return null;
    }
    const hasKey = TELEMETRY_KNOWN_KEYS.some(function (k) {
      return k in raw;
    });
    if (!hasKey) return null;

    const rawTempInt =
      raw.temperatura_interior_c !== undefined ? raw.temperatura_interior_c : raw.tempInterior;
    const rawTempExt =
      raw.temperatura_exterior_c !== undefined ? raw.temperatura_exterior_c : raw.tempExterior;
    const rawHumExt =
      raw.humedad_exterior_pct !== undefined ? raw.humedad_exterior_pct : raw.humedadExterior;
    const rawBat =
      raw.bateria_porcentaje_estimado !== undefined ? raw.bateria_porcentaje_estimado : raw.bateria;

    const tempInterior = parseSensorNumber(
      rawTempInt,
      -45,
      110,
      raw.temperatura_interior_valida !== undefined
        ? raw.temperatura_interior_valida
        : raw.temp_interior_valida
    );
    const tempExterior = parseSensorNumber(
      rawTempExt,
      -45,
      110,
      raw.temperatura_exterior_valida !== undefined
        ? raw.temperatura_exterior_valida
        : raw.clima_exterior_valido
    );
    const humedadExterior = parseSensorNumber(
      rawHumExt,
      0,
      100,
      raw.humedad_exterior_valida !== undefined
        ? raw.humedad_exterior_valida
        : raw.clima_exterior_valido
    );

    const rawBatNum = parseSensorNumber(rawBat, 0, 150, raw.bateria_lectura_valida);
    const bateria = rawBatNum !== null ? Math.min(100, rawBatNum) : null;

    let estadoTapa = 'N/A';
    if (
      raw.tapa_lectura_valida === false ||
      String(raw.tapa_lectura_valida).toLowerCase() === 'false'
    ) {
      estadoTapa = 'N/A';
    } else if (raw.tapa_abierta !== undefined) {
      if (
        raw.tapa_abierta === null ||
        raw.tapa_abierta === '' ||
        String(raw.tapa_abierta).toUpperCase() === 'N/A'
      ) {
        estadoTapa = 'N/A';
      } else if (
        raw.tapa_abierta === true ||
        raw.tapa_abierta === 1 ||
        String(raw.tapa_abierta).toLowerCase() === 'true' ||
        String(raw.tapa_abierta).toUpperCase() === 'ABIERTA'
      ) {
        estadoTapa = 'ABIERTA';
      } else {
        estadoTapa = 'Cerrada';
      }
    } else if (raw.estadoTapa !== undefined) {
      if (!raw.estadoTapa || String(raw.estadoTapa).toUpperCase() === 'N/A') {
        estadoTapa = 'N/A';
      } else if (String(raw.estadoTapa).toUpperCase() === 'ABIERTA') {
        estadoTapa = 'ABIERTA';
      } else {
        estadoTapa = 'Cerrada';
      }
    }

    const tsInfo = parseFlexibleTimestamp(
      raw.timestamp !== undefined ? raw.timestamp : raw.timestamp_unix
    );

    return {
      deviceId: raw.device_id || raw.colmenarId || null,
      tempInterior: tempInterior,
      tempExterior: tempExterior,
      humedadExterior: humedadExterior,
      estadoTapa: estadoTapa,
      bateria: bateria,
      bateriaVoltaje:
        raw.bateria_voltaje_v !== undefined && raw.bateria_voltaje_v !== null
          ? Number(raw.bateria_voltaje_v)
          : null,
      eventoOrigen: raw.evento || null,
      timestamp: tsInfo.iso,
      timestampMs: tsInfo.ms,
    };
  }

  function mapDynamoHistoryToSeries(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const normalized = items
      .map(function (it) {
        return normalizeTelemetryPayload(it);
      })
      .filter(function (it) {
        return (
          it &&
          it.timestampMs &&
          (it.tempInterior !== null || it.tempExterior !== null)
        );
      })
      .sort(function (a, b) {
        return a.timestampMs - b.timestampMs;
      });

    if (normalized.length === 0) return null;

    // Agrupar lecturas reales en ventanas horarias de 1 hora (3.600.000 ms),
    // preservando siempre cualquier pico crítico > 36.0 °C ocurrido en esa hora.
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const bucketMap = {};
    for (let i = 0; i < normalized.length; i++) {
      const item = normalized[i];
      const slotHour = Math.floor(item.timestampMs / ONE_HOUR_MS);
      const slotKey = String(slotHour);
      if (!bucketMap[slotKey]) {
        bucketMap[slotKey] = item;
      } else {
        const prev = bucketMap[slotKey];
        const prevInt = prev.tempInterior !== null ? prev.tempInterior : -Infinity;
        const currInt = item.tempInterior !== null ? item.tempInterior : -Infinity;
        if (prevInt > 36.0 && currInt <= 36.0 && currInt < prevInt) {
          continue;
        }
        bucketMap[slotKey] = item;
      }
    }

    // Construir 10 ventanas horarias de 1 en 1 hora (Eje X cada 1 hora)
    const latestMs = normalized[normalized.length - 1].timestampMs || Date.now();
    const anchorHour = Math.floor(latestMs / ONE_HOUR_MS);
    const series = [];

    for (let offset = 9; offset >= 0; offset--) {
      const targetHour = anchorHour - offset;
      const slotDate = new Date(targetHour * ONE_HOUR_MS);
      const hh = String(slotDate.getHours()).padStart(2, '0');
      const label = hh + ':00';
      const found = bucketMap[String(targetHour)] || null;

      series.push({
        time: label,
        timestamp: slotDate.toISOString(),
        interior:
          found && found.tempInterior !== null && found.tempInterior !== undefined
            ? Number(found.tempInterior)
            : null,
        exterior:
          found && found.tempExterior !== null && found.tempExterior !== undefined
            ? Number(found.tempExterior)
            : null,
        hasData: Boolean(
          found && (found.tempInterior !== null || found.tempExterior !== null)
        ),
      });
    }

    return series;
  }

  function describeDisconnectedSensors(telemetry, status) {
    const missing = [];
    if (status.tempStatus === 'NA') missing.push('Temp. Interior (DS18B20)');
    if (telemetry.tempExterior === null || telemetry.tempExterior === undefined) {
      missing.push('Temp. Exterior (DHT22)');
    }
    if (telemetry.humedadExterior === null || telemetry.humedadExterior === undefined) {
      missing.push('Humedad Exterior (DHT22)');
    }
    if (status.tapaStatus === 'NA') missing.push('Sensor Tapa (Reed Switch)');
    if (status.bateriaStatus === 'NA') missing.push('Batería (Lectura Inválida / ADC)');
    return missing.length > 0 ? missing.join(', ') : 'Sonda del nodo telemétrico';
  }

  function mergeEventsLists(remoteList, localList) {
    const byId = {};
    const keys = [];
    const addItem = function (ev, isRemote) {
      if (!ev || !ev.id || isLegacySeedEvent(ev)) return;
      if (!(ev.id in byId)) {
        keys.push(ev.id);
        byId[ev.id] = ev;
      } else if (isRemote) {
        const prev = byId[ev.id];
        if (!(prev && prev.estadoEvento === 'FINALIZADO' && ev.estadoEvento !== 'FINALIZADO')) {
          byId[ev.id] = ev;
        }
      }
    };
    (localList || []).forEach(function (ev) {
      addItem(ev, false);
    });
    (remoteList || []).forEach(function (ev) {
      addItem(ev, true);
    });
    return keys
      .map(function (k) {
        return byId[k];
      })
      .sort(function (a, b) {
        const ta = Number(a.startTimestampMs || 0);
        const tb = Number(b.startTimestampMs || 0);
        if (ta && tb && ta !== tb) return tb - ta;
        return String(b.id || '').localeCompare(String(a.id || ''));
      });
  }

  function evaluateTelemetryStatus(telemetry, currentNowMs) {
    const cfg = getRuntimeConfig();
    const thresholdSec =
      Number(cfg.deviceOfflineThresholdSeconds) ||
      Number(cfg.deviceTimeoutSeconds) ||
      60;
    const thresholdMs = thresholdSec * 1000;
    const nowMs = typeof currentNowMs === 'number' ? currentNowMs : Date.now();

    let deviceOffline = false;
    let secondsSinceLastReading = null;

    if (!telemetry || typeof telemetry !== 'object') {
      deviceOffline = true;
    } else if (telemetry.deviceOffline === true) {
      deviceOffline = true;
    } else if (cfg.productionMode || cfg.apiBaseUrl) {
      const tsMs =
        typeof telemetry.timestampMs === 'number' && Number.isFinite(telemetry.timestampMs)
          ? telemetry.timestampMs
          : telemetry.timestamp
          ? new Date(telemetry.timestamp).getTime()
          : null;

      if (!tsMs || Number.isNaN(tsMs)) {
        deviceOffline = true;
      } else {
        const diffMs = nowMs - tsMs;
        secondsSinceLastReading = Math.max(0, Math.round(diffMs / 1000));
        // Si no se han recibido lecturas dentro del umbral (ej. 120s) o timestamp anómalo a futuro (> 5 min)
        if (diffMs > thresholdMs || diffMs < -300000) {
          deviceOffline = true;
        }
      }
    }

    if (deviceOffline) {
      return {
        tempStatus: 'NA',
        climaExteriorStatus: 'NA',
        tapaStatus: 'NA',
        bateriaStatus: 'NA',
        anySensorDisconnected: true,
        deviceOffline: true,
        secondsSinceLastReading: secondsSinceLastReading,
        thresholdSeconds: thresholdSec,
      };
    }

    const tempInterior = telemetry.tempInterior;
    const tempExterior = telemetry.tempExterior;
    const humedadExterior = telemetry.humedadExterior;
    const estadoTapa = telemetry.estadoTapa;
    const bateria = telemetry.bateria;

    let tempStatus = 'NORMAL';
    if (
      tempInterior === null ||
      tempInterior === undefined ||
      Number.isNaN(Number(tempInterior))
    ) {
      tempStatus = 'NA';
    } else if (Number(tempInterior) > 36.0) {
      tempStatus = 'HIGH_ALERT';
    } else if (Number(tempInterior) < 15.0) {
      tempStatus = 'LOW_BLINK_ALERT';
    }

    const extTempNA =
      tempExterior === null || tempExterior === undefined || Number.isNaN(Number(tempExterior));
    const extHumNA =
      humedadExterior === null ||
      humedadExterior === undefined ||
      Number.isNaN(Number(humedadExterior));
    const climaExteriorStatus = extTempNA || extHumNA ? 'NA' : 'NORMAL';

    let tapaStatus = 'NORMAL';
    if (!estadoTapa || estadoTapa === 'N/A') {
      tapaStatus = 'NA';
    } else if (String(estadoTapa).toUpperCase() === 'ABIERTA') {
      tapaStatus = 'OPEN_BLINK_ALERT';
    }

    const batThreshold = cfg.batteryAlertThreshold;
    const criticalBatLimit = Number.isFinite(batThreshold) ? batThreshold : 10.0;
    let bateriaStatus = 'NORMAL';
    if (bateria === null || bateria === undefined || Number.isNaN(Number(bateria))) {
      bateriaStatus = 'NA';
    } else if (Number(bateria) < criticalBatLimit) {
      bateriaStatus = 'CRITICAL_BLINK_10';
    } else if (Number(bateria) < 20.0) {
      bateriaStatus = 'LOW_ALERT_20';
    }

    const anySensorDisconnected =
      tempStatus === 'NA' ||
      climaExteriorStatus === 'NA' ||
      tapaStatus === 'NA' ||
      bateriaStatus === 'NA';

    return {
      tempStatus,
      climaExteriorStatus,
      tapaStatus,
      bateriaStatus,
      anySensorDisconnected,
      deviceOffline: false,
      secondsSinceLastReading: secondsSinceLastReading,
      thresholdSeconds: thresholdSec,
    };
  }

  async function fetchEventsFromDynamoDB() {
    const cfg = getRuntimeConfig();
    let localEvents = [];
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_EVENTS_KEY);
      if (raw) localEvents = JSON.parse(raw) || [];
    } catch (e) {}

    if (cfg.apiBaseUrl) {
      try {
        const baseQ =
          'device_id=' +
          encodeURIComponent(cfg.colmenarId) +
          '&colmenarId=' +
          encodeURIComponent(cfg.colmenarId) +
          '&_t=' +
          Date.now();
        const url = cfg.singleRouteMode
          ? cfg.apiBaseUrl + getEffectiveTelemetryRoute(cfg) + '?action=events&' + baseQ
          : cfg.apiBaseUrl + '/events?' + baseQ;

        const res = await fetch(url, {
          method: 'GET',
          headers: buildApiHeaders('GET'),
        });
        if (res.ok) {
          let data = await res.json();
          if (data && typeof data.body === 'string') {
            try {
              data = JSON.parse(data.body);
            } catch (e) {}
          }
          const list = Array.isArray(data)
            ? data
            : Array.isArray(data && data.items)
            ? data.items
            : Array.isArray(data && data.events)
            ? data.events
            : null;
          if (list) {
            const merged = mergeEventsLists(list, localEvents);
            try {
              localStorage.setItem(LOCAL_STORAGE_EVENTS_KEY, JSON.stringify(merged));
            } catch (e) {}
            return merged;
          }
        }
      } catch (e) {}
    }
    return localEvents;
  }

  async function registerEventStartInDynamoDB(newEvent) {
    const cfg = getRuntimeConfig();
    const existing = await fetchEventsFromDynamoDB();
    const alreadyActive = existing.find(function (ev) {
      return ev.estadoEvento === 'ACTIVO' && ev.tipoEvento === newEvent.tipoEvento;
    });
    if (alreadyActive) return existing;

    const enriched = Object.assign(
      {
        device_id: cfg.colmenarId,
        colmenarId: cfg.colmenarId,
        startTimestampMs: Date.now(),
      },
      newEvent
    );
    const updated = [enriched].concat(existing);
    try {
      localStorage.setItem(LOCAL_STORAGE_EVENTS_KEY, JSON.stringify(updated));
    } catch (e) {}

    if (cfg.apiBaseUrl) {
      try {
        if (cfg.singleRouteMode) {
          const q =
            'action=save_event&device_id=' +
            encodeURIComponent(cfg.colmenarId) +
            '&payload=' +
            encodeURIComponent(JSON.stringify(enriched)) +
            '&_t=' +
            Date.now();
          await fetch(cfg.apiBaseUrl + getEffectiveTelemetryRoute(cfg) + '?' + q, {
            method: 'GET',
            headers: buildApiHeaders('GET'),
          });
        } else {
          await fetch(cfg.apiBaseUrl + '/events', {
            method: 'POST',
            headers: buildApiHeaders('POST'),
            body: JSON.stringify(enriched),
          });
        }
      } catch (e) {}
    }
    return updated;
  }

  async function registerEventEndInDynamoDB(eventId, fechaTermino, isoTermino) {
    const cfg = getRuntimeConfig();
    const existing = await fetchEventsFromDynamoDB();
    const updated = existing.map(function (ev) {
      return ev.id === eventId
        ? Object.assign({}, ev, {
            fechaTermino: fechaTermino,
            isoTermino: isoTermino,
            estadoEvento: 'FINALIZADO',
          })
        : ev;
    });
    try {
      localStorage.setItem(LOCAL_STORAGE_EVENTS_KEY, JSON.stringify(updated));
    } catch (e) {}

    if (cfg.apiBaseUrl) {
      try {
        if (cfg.singleRouteMode) {
          const q =
            'action=close_event&device_id=' +
            encodeURIComponent(cfg.colmenarId) +
            '&id=' +
            encodeURIComponent(eventId) +
            '&fechaTermino=' +
            encodeURIComponent(fechaTermino) +
            '&isoTermino=' +
            encodeURIComponent(isoTermino) +
            '&_t=' +
            Date.now();
          await fetch(cfg.apiBaseUrl + getEffectiveTelemetryRoute(cfg) + '?' + q, {
            method: 'GET',
            headers: buildApiHeaders('GET'),
          });
        } else {
          await fetch(cfg.apiBaseUrl + '/events/' + encodeURIComponent(eventId), {
            method: 'PATCH',
            headers: buildApiHeaders('PATCH'),
            body: JSON.stringify({
              device_id: cfg.colmenarId,
              colmenarId: cfg.colmenarId,
              fechaTermino: fechaTermino,
              isoTermino: isoTermino,
              estadoEvento: 'FINALIZADO',
            }),
          });
        }
      } catch (e) {}
    }
    return updated;
  }

  async function dispatchRealSmsAlert(params) {
    const cfg = getRuntimeConfig();
    const nombreColmenar = (params && params.nombreColmenar) || cfg.nombreColmenar;
    const mensaje =
      (params && params.mensaje) ||
      'ALERTA!!! Tapa de colmena abierta (' + nombreColmenar + ')';

    if (cfg.apiBaseUrl) {
      try {
        let res;
        if (cfg.singleRouteMode) {
          const q =
            'action=sms_alert&device_id=' +
            encodeURIComponent(cfg.colmenarId) +
            '&nombreColmenar=' +
            encodeURIComponent(nombreColmenar) +
            '&mensaje=' +
            encodeURIComponent(mensaje) +
            '&_t=' +
            Date.now();
          res = await fetch(cfg.apiBaseUrl + getEffectiveTelemetryRoute(cfg) + '?' + q, {
            method: 'GET',
            headers: buildApiHeaders('GET'),
          });
        } else {
          res = await fetch(cfg.apiBaseUrl + '/sms-alert', {
            method: 'POST',
            headers: buildApiHeaders('POST'),
            body: JSON.stringify({
              colmenarId: cfg.colmenarId,
              nombreColmenar: nombreColmenar,
              mensaje: mensaje,
            }),
          });
        }
        if (res.ok) {
          let data = await res.json();
          if (data && typeof data.body === 'string') {
            try {
              data = JSON.parse(data.body);
            } catch (e) {}
          }
          if (data && data.ok) {
            return {
              ok: true,
              messageId: data.messageId || null,
              telefonoMasked: data.telefonoMasked || 'Celular registrado',
            };
          }
        }
      } catch (e) {}
    }

    const bridge = cfg.smsBridgeUrl || 'http://localhost:8765';
    if (bridge) {
      try {
        const res = await fetch(bridge.replace(/\/+$/, '') + '/api/sms/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nombreColmenar: nombreColmenar, mensaje: mensaje }),
        });
        const data = await res.json();
        return {
          ok: Boolean(data && data.ok),
          messageId: (data && data.messageId) || null,
          telefonoMasked: (data && data.telefonoMasked) || 'Celular registrado',
        };
      } catch (e) {}
    }

    return { ok: false, messageId: null, telefonoMasked: 'Celular del apicultor' };
  }

  async function fetchLatestTelemetryFromAWS() {
    const cfg = getRuntimeConfig();
    if (!cfg.apiBaseUrl) return null;
    const configured = cfg.telemetryRoute
      ? cfg.telemetryRoute.charAt(0) === '/'
        ? cfg.telemetryRoute
        : '/' + cfg.telemetryRoute
      : '/telemetry';

    const candidates = resolvedActiveRoute
      ? [resolvedActiveRoute]
      : [
          configured,
          '/telemetry',
          '/prod/telemetry',
          '/dev/telemetry',
          '/v1/telemetry',
          '/',
        ].filter(function (v, idx, arr) {
          return arr.indexOf(v) === idx;
        });

    const query =
      'device_id=' +
      encodeURIComponent(cfg.colmenarId) +
      '&colmenarId=' +
      encodeURIComponent(cfg.colmenarId) +
      '&limit=360&history=true&_t=' +
      Date.now();

    try {
      let res = null;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const sep = candidate === '/' ? '/' : candidate;
        const attempt = await fetch(cfg.apiBaseUrl + sep + '?' + query, {
          method: 'GET',
          headers: buildApiHeaders('GET'),
        });
        if (attempt.ok) {
          res = attempt;
          resolvedActiveRoute = candidate;
          break;
        }
        if (attempt.status !== 404) {
          res = attempt;
          break;
        }
      }
      if (!res || !res.ok) return null;

      let payload = await res.json();
      if (payload && typeof payload.body === 'string') {
        try {
          payload = JSON.parse(payload.body);
        } catch (e) {}
      }
      if (!payload) return { latest: null, historySeries: null, events: null };

      function extractNewest(arr) {
        const norm = arr
          .map(function (it) {
            return normalizeTelemetryPayload(it);
          })
          .filter(Boolean)
          .sort(function (a, b) {
            return a.timestampMs - b.timestampMs;
          });
        return norm.length > 0 ? norm[norm.length - 1] : null;
      }

      if (Array.isArray(payload)) {
        return {
          latest: extractNewest(payload),
          historySeries: mapDynamoHistoryToSeries(payload),
          events: null,
        };
      }

      const listCandidate =
        (Array.isArray(payload.items) && payload.items.length > 0 ? payload.items : null) ||
        (Array.isArray(payload.history) && payload.history.length > 0 ? payload.history : null) ||
        payload.Items ||
        payload.data ||
        payload.telemetry ||
        null;

      const latestNormalized = payload.latest
        ? normalizeTelemetryPayload(payload.latest)
        : Array.isArray(listCandidate)
        ? extractNewest(listCandidate)
        : normalizeTelemetryPayload(payload);

      let syncedEvents = null;
      if (Array.isArray(payload.events)) {
        let localEv = [];
        try {
          const rawLocal = localStorage.getItem(LOCAL_STORAGE_EVENTS_KEY);
          if (rawLocal) localEv = JSON.parse(rawLocal) || [];
        } catch (e) {}
        syncedEvents = mergeEventsLists(payload.events, localEv);
        try {
          localStorage.setItem(LOCAL_STORAGE_EVENTS_KEY, JSON.stringify(syncedEvents));
        } catch (e) {}
      }

      return {
        latest: latestNormalized,
        historySeries: Array.isArray(listCandidate)
          ? mapDynamoHistoryToSeries(listCandidate)
          : latestNormalized
          ? mapDynamoHistoryToSeries([latestNormalized])
          : null,
        events: syncedEvents,
      };
    } catch (e) {
      return null;
    }
  }

  function connectAwsIotWebSocket(onTelemetryReceived) {
    const cfg = getRuntimeConfig();
    if (!cfg.iotWss.enabled) return function () {};

    let ws = null;
    let reconnectTimer = null;
    let closedManually = false;

    async function resolveWssUrl() {
      if (cfg.iotWss.wssUrl) return cfg.iotWss.wssUrl;
      if (cfg.iotWss.usePresignedEndpoint && cfg.apiBaseUrl) {
        try {
          const res = await fetch(
            cfg.apiBaseUrl + '/iot-wss-url?colmenarId=' + encodeURIComponent(cfg.colmenarId),
            { method: 'GET', headers: buildApiHeaders() }
          );
          if (res.ok) {
            const data = await res.json();
            return (data && (data.url || data.wssUrl)) || '';
          }
        } catch (e) {}
      }
      return '';
    }

    async function openSocket() {
      if (closedManually) return;
      const url = await resolveWssUrl();
      if (!url) return;
      try {
        ws = new WebSocket(url);
        ws.onmessage = function (evt) {
          try {
            const txt = typeof evt.data === 'string' ? evt.data : '';
            if (!txt) return;
            const s = txt.indexOf('{');
            const e = txt.lastIndexOf('}');
            if (s !== -1 && e > s) {
              const parsed = JSON.parse(txt.slice(s, e + 1));
              const norm = normalizeTelemetryPayload(parsed);
              if (norm && onTelemetryReceived) onTelemetryReceived(norm);
            }
          } catch (err) {}
        };
        ws.onclose = function () {
          if (!closedManually) reconnectTimer = setTimeout(openSocket, 5000);
        };
        ws.onerror = function () {
          try {
            ws.close();
          } catch (err) {}
        };
      } catch (err) {}
    }

    openSocket();

    return function () {
      closedManually = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }
    };
  }

  /* ==========================================================================
     3. EXPORTACIÓN DE REPORTES OFICIALES A PDF (CON LOGOTIPO BEESENSE)
     ========================================================================== */
  function exportEventsToPDF(events, filters) {
    if (!window.jspdf || !window.jspdf.jsPDF) return;
    const cfg = getRuntimeConfig();
    const jsPDF = window.jspdf.jsPDF;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    const headerHeight = 36;
    doc.setFillColor(18, 43, 82);
    doc.rect(0, 0, 297, headerHeight, 'F');

    doc.setFillColor(212, 160, 23);
    doc.rect(0, headerHeight - 1.5, 297, 1.5, 'F');

    const badgeX = 14;
    const badgeY = 5.5;
    const badgeW = 64;
    const badgeH = 23.5;
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 3, 3, 'F');

    const aspect = window.BEESENSE_LOGO_ASPECT_RATIO || 3.269;
    const logoMaxW = 58;
    const logoH = Number((logoMaxW / aspect).toFixed(2));
    const logoX = badgeX + (badgeW - logoMaxW) / 2;
    const logoY = badgeY + (badgeH - logoH) / 2;

    try {
      if (window.BEESENSE_LOGO_BASE64) {
        doc.addImage(
          window.BEESENSE_LOGO_BASE64,
          'PNG',
          logoX,
          logoY,
          logoMaxW,
          logoH,
          undefined,
          'SLOW'
        );
      } else {
        throw new Error('No base64');
      }
    } catch (err) {
      doc.setTextColor(18, 43, 82);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.text('BeeSense IoT', badgeX + 8, badgeY + 14);
    }

    const textStartX = 84;
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15.5);
    doc.text('REPORTE OFICIAL DE EVENTOS Y ALERTAS TELEMÉTRICAS IoT', textStartX, 14);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(203, 213, 225);
    doc.text(
      'Colmenar: ' +
        cfg.nombreColmenar +
        '   |   Fecha de emisión: ' +
        formatDateTimeCL(new Date()),
      textStartX,
      21.5
    );

    const f = filters || {};
    const tipoLabel = f.tipoEvento || 'TODOS';
    const desdeLabel = f.fechaDesde || 'Inicio';
    const hastaLabel = f.fechaHasta || 'Actualidad';
    const horarioLabel = f.rangoHorarioActivo
      ? (f.horaDesde || '00:00') + ' a ' + (f.horaHasta || '23:59') + ' hrs'
      : 'Día completo';

    doc.setTextColor(245, 158, 11);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(
      'Filtros -> Tipo: ' +
        tipoLabel +
        '  |  Fechas: ' +
        desdeLabel +
        ' - ' +
        hastaLabel +
        '  |  Horario: ' +
        horarioLabel +
        '  |  Total: ' +
        events.length +
        ' evento(s)',
      textStartX,
      28.5
    );

    const tableRows = events.map(function (ev, idx) {
      return [
        idx + 1,
        ev.nombreColmenar || cfg.nombreColmenar,
        ev.tipoEvento || 'N/A',
        ev.titulo || ev.tipoEvento,
        ev.detalle || '-',
        ev.fechaInicio || '-',
        ev.fechaTermino || 'En curso (Activa)',
      ];
    });

    doc.autoTable({
      startY: 42,
      head: [
        [
          '#',
          'Nombre de Colmenar',
          'Categoría',
          'Evento',
          'Descripción Detallada',
          'Fecha y Hora de Inicio',
          'Fecha y Hora de Término',
        ],
      ],
      body:
        tableRows.length > 0
          ? tableRows
          : [
              [
                '-',
                cfg.nombreColmenar,
                'SIN REGISTROS',
                'No existen eventos para los filtros seleccionados',
                '-',
                '-',
                '-',
              ],
            ],
      theme: 'grid',
      headStyles: {
        fillColor: [18, 43, 82],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 9,
      },
      bodyStyles: { fontSize: 8.5, textColor: [30, 41, 59] },
      alternateRowStyles: { fillColor: [244, 247, 251] },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center' },
        1: { cellWidth: 46, fontStyle: 'bold' },
        2: { cellWidth: 34, fontStyle: 'bold' },
        3: { cellWidth: 38 },
        4: { cellWidth: 63 },
        5: { cellWidth: 39 },
        6: { cellWidth: 39 },
      },
      didDrawPage: function (data) {
        const pageH = doc.internal.pageSize.height || doc.internal.pageSize.getHeight();
        doc.setFontSize(8.5);
        doc.setTextColor(100, 116, 139);
        doc.text(
          'BeeSense 2026. — Plataforma de Monitoreo Apícola IoT — Página ' + data.pageNumber,
          14,
          pageH - 8
        );
      },
    });

    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    doc.save('BeeSense_Reporte_Eventos_' + ts + '.pdf');
  }

  /* ==========================================================================
     4. SISTEMA DE ICONOS VECTORIALES SVG NATIVOS
     ========================================================================== */
  function Icon(props) {
    const name = props.name;
    const className = props.className || 'w-5 h-5';
    const baseProps = {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: props.strokeWidth || 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: className,
      'aria-hidden': 'true',
    };

    switch (name) {
      case 'home':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5z' })
        );
      case 'fileText':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
          h('polyline', { points: '14 2 14 8 20 8' }),
          h('line', { x1: 16, y1: 13, x2: 8, y2: 13 }),
          h('line', { x1: 16, y1: 17, x2: 8, y2: 17 })
        );
      case 'user':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }),
          h('circle', { cx: 12, cy: 7, r: 4 })
        );
      case 'logOut':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }),
          h('polyline', { points: '16 17 21 12 16 7' }),
          h('line', { x1: 21, y1: 12, x2: 9, y2: 12 })
        );
      case 'moon':
        return h('svg', baseProps, h('path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' }));
      case 'sun':
        return h(
          'svg',
          baseProps,
          h('circle', { cx: 12, cy: 12, r: 4 }),
          h('path', {
            d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
          })
        );
      case 'menu':
        return h(
          'svg',
          baseProps,
          h('line', { x1: 4, y1: 6, x2: 20, y2: 6 }),
          h('line', { x1: 4, y1: 12, x2: 20, y2: 12 }),
          h('line', { x1: 4, y1: 18, x2: 20, y2: 18 })
        );
      case 'x':
        return h(
          'svg',
          baseProps,
          h('line', { x1: 18, y1: 6, x2: 6, y2: 18 }),
          h('line', { x1: 6, y1: 6, x2: 18, y2: 18 })
        );
      case 'thermometer':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z' })
        );
      case 'droplets':
        return h(
          'svg',
          baseProps,
          h('path', {
            d: 'M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z',
          }),
          h('path', {
            d: 'M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97',
          })
        );
      case 'alertTriangle':
        return h(
          'svg',
          baseProps,
          h('path', {
            d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z',
          }),
          h('line', { x1: 12, y1: 9, x2: 12, y2: 13 }),
          h('line', { x1: 12, y1: 17, x2: 12.01, y2: 17 })
        );
      case 'battery':
        return h(
          'svg',
          baseProps,
          h('rect', { x: 2, y: 7, width: 16, height: 10, rx: 2, ry: 2 }),
          h('line', { x1: 22, y1: 11, x2: 22, y2: 13 })
        );
      case 'batteryWarning':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M10 7v6M10 17h.01' }),
          h('rect', { x: 2, y: 7, width: 16, height: 10, rx: 2, ry: 2 }),
          h('line', { x1: 22, y1: 11, x2: 22, y2: 13 })
        );
      case 'wifiOff':
        return h(
          'svg',
          baseProps,
          h('line', { x1: 2, y1: 2, x2: 22, y2: 22 }),
          h('path', { d: 'M8.5 16.5a5 5 0 0 1 7 0' }),
          h('path', { d: 'M2 8.82a15 15 0 0 1 4.17-2.65' }),
          h('path', { d: 'M10.66 5c4.01-.36 8.14.9 11.34 3.76' }),
          h('path', { d: 'M16.85 11.25a10 10 0 0 1 2.22 1.68' }),
          h('path', { d: 'M5 12.86a10 10 0 0 1 5.17-2.89' }),
          h('line', { x1: 12, y1: 20, x2: 12.01, y2: 20 })
        );
      case 'shieldAlert':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }),
          h('path', { d: 'M12 8v4M12 16h.01' })
        );
      case 'box':
        return h(
          'svg',
          baseProps,
          h('path', {
            d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
          }),
          h('path', { d: 'm3.3 7 8.7 5 8.7-5M12 22V12' })
        );
      case 'fileDown':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
          h('polyline', { points: '14 2 14 8 20 8' }),
          h('path', { d: 'M12 18v-6M9 15l3 3 3-3' })
        );
      case 'calendar':
        return h(
          'svg',
          baseProps,
          h('rect', { x: 3, y: 4, width: 18, height: 18, rx: 2, ry: 2 }),
          h('line', { x1: 16, y1: 2, x2: 16, y2: 6 }),
          h('line', { x1: 8, y1: 2, x2: 8, y2: 6 }),
          h('line', { x1: 3, y1: 10, x2: 21, y2: 10 })
        );
      case 'filter':
        return h('svg', baseProps, h('polygon', { points: '22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3' }));
      case 'rotateCcw':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
          h('path', { d: 'M3 3v5h5' })
        );
      case 'clock':
        return h(
          'svg',
          baseProps,
          h('circle', { cx: 12, cy: 12, r: 10 }),
          h('polyline', { points: '12 6 12 12 16 14' })
        );
      case 'checkCircle':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }),
          h('polyline', { points: '22 4 12 14.01 9 11.01' })
        );
      case 'zap':
        return h('svg', baseProps, h('polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }));
      case 'mapPin':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z' }),
          h('circle', { cx: 12, cy: 10, r: 3 })
        );
      case 'smartphone':
        return h(
          'svg',
          baseProps,
          h('rect', { width: 14, height: 20, x: 5, y: 2, rx: 2, ry: 2 }),
          h('path', { d: 'M12 18h.01' })
        );
      case 'camera':
        return h(
          'svg',
          baseProps,
          h('path', {
            d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z',
          }),
          h('circle', { cx: 12, cy: 13, r: 3 })
        );
      case 'trash':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' })
        );
      case 'upload':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
          h('polyline', { points: '17 8 12 3 7 8' }),
          h('line', { x1: 12, y1: 3, x2: 12, y2: 15 })
        );
      case 'messageSms':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }),
          h('path', { d: 'M13 8H7M17 12H7' })
        );
      case 'compass':
        return h(
          'svg',
          baseProps,
          h('circle', { cx: 12, cy: 12, r: 10 }),
          h('polygon', { points: '16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76' })
        );
      case 'cloudSun':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41' }),
          h('path', { d: 'M15.5 13a4.5 4.5 0 0 0-4.5-4.5c-.7 0-1.36.16-1.95.45A5 5 0 0 0 4 14a5 5 0 0 0 5 5h7a4 4 0 0 0 4-4 4 4 0 0 0-4.5-4z' })
        );
      case 'cloud':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' })
        );
      case 'cloudRain':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' }),
          h('path', { d: 'M16 14v6M8 14v6M12 16v6' })
        );
      case 'wind':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2' }),
          h('path', { d: 'M9.6 4.6A2 2 0 1 1 11 8H2' }),
          h('path', { d: 'M12.6 19.4A2 2 0 1 0 14 16H2' })
        );
      case 'refreshCw':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
          h('path', { d: 'M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
          h('path', { d: 'M8 16H3v5' })
        );
      case 'navigation':
        return h(
          'svg',
          baseProps,
          h('polygon', { points: '3 11 22 2 13 21 11 13 3 11' })
        );
      case 'arrowLeft':
        return h(
          'svg',
          baseProps,
          h('path', { d: 'm12 19-7-7 7-7M19 12H5' })
        );
      case 'chevronLeft':
        return h(
          'svg',
          baseProps,
          h('polyline', { points: '15 18 9 12 15 6' })
        );
      case 'chevronRight':
        return h(
          'svg',
          baseProps,
          h('polyline', { points: '9 18 15 12 9 6' })
        );
      default:
        return null;
    }
  }

  /* ==========================================================================
     5. ENJAMBRE DE ABEJAS ANIMADAS, LOGIN Y VISTA 404 DE RUTAS INEXISTENTES
     ========================================================================== */
  function AnimatedBee(props) {
    const size = props.size || 36;
    const flip = Boolean(props.flip);
    return h(
      'div',
      {
        className: 'bee-hover-float pointer-events-none select-none',
        style: { width: size, height: size, transform: flip ? 'scaleX(-1)' : undefined },
      },
      h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: size,
          height: size,
          className: 'drop-shadow-[0_4px_10px_rgba(255,251,235,0.65)]',
        },
        h('circle', { cx: 33, cy: 32, r: 22, fill: 'rgba(254, 243, 199, 0.22)' }),
        h(
          'g',
          { className: 'bee-wing' },
          h('ellipse', {
            cx: 26,
            cy: 18,
            rx: 10,
            ry: 14,
            fill: 'rgba(255,255,255,0.92)',
            stroke: '#94a3b8',
            strokeWidth: 1.6,
            transform: 'rotate(-22 26 18)',
          }),
          h('ellipse', {
            cx: 38,
            cy: 18,
            rx: 10,
            ry: 14,
            fill: 'rgba(255,255,255,0.88)',
            stroke: '#94a3b8',
            strokeWidth: 1.6,
            transform: 'rotate(22 38 18)',
          })
        ),
        h('polygon', { points: '9,34 18,30 18,38', fill: '#0f172a' }),
        h('ellipse', {
          cx: 33,
          cy: 34,
          rx: 17,
          ry: 12,
          fill: '#fbbf24',
          stroke: '#0f172a',
          strokeWidth: 2.6,
        }),
        h('path', {
          d: 'M26 23 C25 34, 25 34, 26 45',
          stroke: '#0f172a',
          strokeWidth: 4.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M35 22 C34 34, 34 34, 35 46',
          stroke: '#0f172a',
          strokeWidth: 4.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M43 25 C42 34, 42 34, 43 43',
          stroke: '#0f172a',
          strokeWidth: 3.8,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 45, cy: 31, r: 2.2, fill: '#ffffff' }),
        h('path', {
          d: 'M47 26 Q52 19 56 21',
          fill: 'none',
          stroke: '#0f172a',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M49 28 Q55 24 58 27',
          fill: 'none',
          stroke: '#0f172a',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
        })
      )
    );
  }

  function BeeSwarmOverlay() {
    const flights = [
      { cls: 'bee-flight-1', size: 38, delay: '0s' },
      { cls: 'bee-flight-2', size: 34, delay: '-4s' },
      { cls: 'bee-flight-3', size: 36, delay: '-2s' },
      { cls: 'bee-flight-4', size: 32, delay: '-7s' },
      { cls: 'bee-flight-5', size: 35, delay: '-5s' },
      { cls: 'bee-flight-6', size: 30, delay: '-9s' },
      { cls: 'bee-flight-7', size: 34, delay: '-11s' },
      { cls: 'bee-flight-8', size: 29, delay: '-3s' },
    ];
    return h(
      'div',
      { className: 'pointer-events-none fixed inset-0 z-10 overflow-hidden' },
      flights.map(function (f, i) {
        return h(
          'div',
          {
            key: i,
            className: f.cls + ' absolute left-0 top-0',
            style: { animationDelay: f.delay },
          },
          h(AnimatedBee, { size: f.size })
        );
      }),
      h(
        'div',
        { className: 'bee-orbit absolute left-[7%] top-[14%]' },
        h(AnimatedBee, { size: 34 })
      ),
      h(
        'div',
        { className: 'bee-orbit absolute right-[8%] top-[18%]', style: { animationDelay: '-2.5s' } },
        h(AnimatedBee, { size: 32, flip: true })
      ),
      h(
        'div',
        { className: 'bee-orbit absolute left-[9%] bottom-[16%]', style: { animationDelay: '-4s' } },
        h(AnimatedBee, { size: 31 })
      ),
      h(
        'div',
        { className: 'bee-orbit absolute right-[7%] bottom-[20%]', style: { animationDelay: '-1.5s' } },
        h(AnimatedBee, { size: 36, flip: true })
      )
    );
  }

  function NotFound404Screen(props) {
    const darkMode = props.darkMode;
    const isAuthenticated = props.isAuthenticated;
    const onReturnHome = props.onReturnHome;

    return h(
      'div',
      {
        className:
          'relative min-h-screen w-full overflow-hidden flex flex-col justify-between items-center px-4 py-6 ' +
          (darkMode
            ? 'bg-gradient-to-br from-slate-950 via-[#0B1C38] to-slate-900'
            : 'honeycomb-animated-bg'),
      },
      h(BeeSwarmOverlay),
      h('div', { className: 'h-2' }),
      h(
        'main',
        {
          className:
            'relative z-20 w-[88vw] max-w-[350px] sm:max-w-[520px] bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-[26px] sm:rounded-[32px] shadow-2xl border border-amber-200/80 dark:border-slate-700/80 px-6 py-8 sm:px-12 sm:py-11 flex flex-col items-center text-center',
        },
        h('img', {
          src: darkMode ? './assets/logo-desktop-dark.png' : './assets/logo-desktop.png',
          alt: 'BeeSense IoT',
          className: 'h-11 sm:h-14 w-auto object-contain mb-5 select-none',
        }),
        h(
          'span',
          {
            className:
              'inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 text-[11px] sm:text-xs font-extrabold uppercase tracking-wider mb-4 border border-amber-300/60 dark:border-amber-500/30',
          },
          h(Icon, { name: 'compass', className: 'w-3.5 h-3.5' }),
          h('span', null, 'Error 404 • Fuera del Colmenar')
        ),
        h(
          'div',
          { className: 'flex items-center justify-center gap-2 sm:gap-4 my-2 select-none' },
          h(
            'span',
            { className: 'text-6xl sm:text-8xl font-black tracking-tighter text-[#122B52] dark:text-white' },
            '4'
          ),
          h(
            'div',
            { className: 'relative w-16 h-16 sm:w-24 sm:h-24 flex items-center justify-center' },
            h(
              'svg',
              { viewBox: '0 0 100 100', className: 'w-full h-full' },
              h('polygon', {
                points: '50,6 92,28 92,72 50,94 8,72 8,28',
                fill: 'rgba(245, 158, 11, 0.18)',
                stroke: '#D4A017',
                strokeWidth: 5,
              })
            ),
            h(
              'div',
              { className: 'absolute inset-0 flex items-center justify-center' },
              h(AnimatedBee, { size: 42 })
            )
          ),
          h(
            'span',
            { className: 'text-6xl sm:text-8xl font-black tracking-tighter text-[#2A9D8F] dark:text-teal-400' },
            '4'
          )
        ),
        h(
          'h1',
          { className: 'text-lg sm:text-2xl font-extrabold text-[#122B52] dark:text-white mt-2 mb-2.5' },
          '¡Zumbido perdido! Esta celda del panal no existe'
        ),
        h(
          'p',
          { className: 'text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-md mb-7' },
          'Nuestras abejas exploradoras recorrieron todo el colmenar pero no lograron encontrar la ruta o página solicitada.'
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: onReturnHome,
            className:
              'w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-2xl bg-[#122B52] dark:bg-amber-500 hover:bg-[#1a3b6e] dark:hover:bg-amber-400 text-white dark:text-slate-950 font-extrabold text-xs sm:text-sm shadow-lg transition-all',
          },
          h(Icon, { name: isAuthenticated ? 'home' : 'arrowLeft', className: 'w-4 h-4' }),
          h(
            'span',
            null,
            isAuthenticated ? 'Volver al Dashboard en Tiempo Real' : 'Volver a la Pantalla de Acceso'
          )
        )
      ),
      h(
        'footer',
        { className: 'relative z-20 mt-4 text-center' },
        h(
          'div',
          {
            className:
              'inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#122B52]/85 backdrop-blur-sm text-amber-300 text-xs font-bold tracking-wide shadow-md border border-amber-300/30',
          },
          h('span', { className: 'w-2 h-2 rounded-full bg-teal-400' }),
          h('span', null, 'BeeSense 2026.')
        )
      )
    );
  }

  function LoginScreen(props) {
    const onLoginSuccess = props.onLoginSuccess;
    const [isLoading, setIsLoading] = useState(false);
    const [progressWidth, setProgressWidth] = useState(20);

    // Si el usuario retrocede con el botón "Atrás" del navegador desde Cognito,
    // Firefox/Chrome restauran la página de la memoria caché (bfcache).
    // Estos oyentes garantizan que la pantalla se restablezca de inmediato al index sin trabas.
    useEffect(function () {
      function resetState() {
        setIsLoading(false);
        setProgressWidth(20);
      }

      window.addEventListener('pageshow', resetState);
      window.addEventListener('popstate', resetState);
      window.addEventListener('focus', resetState);

      return function () {
        window.removeEventListener('pageshow', resetState);
        window.removeEventListener('popstate', resetState);
        window.removeEventListener('focus', resetState);
      };
    }, []);

    // Temporizador de seguridad: si por cualquier motivo no se concreta la navegación,
    // se devuelve al usuario a la pantalla principal automáticamente en 4 segundos
    useEffect(
      function () {
        if (!isLoading) return;
        const timer = setTimeout(function () {
          setIsLoading(false);
          setProgressWidth(20);
        }, 4000);
        return function () {
          clearTimeout(timer);
        };
      },
      [isLoading]
    );

    async function handleCognitoLogin() {
      if (isLoading) return;
      setIsLoading(true);
      setProgressWidth(40);

      let cognitoUrl = null;
      try {
        cognitoUrl = await buildCognitoAuthorizeUrlAsync();
      } catch (err) {
        cognitoUrl = buildCognitoAuthorizeUrl();
      }

      if (cognitoUrl) {
        setProgressWidth(85);
        // Restablecer isLoading antes de que se guarde en el historial de navegación
        // para que al presionar el botón "Atrás" la página cargue inmediatamente limpia
        setTimeout(function () {
          setIsLoading(false);
          setProgressWidth(20);
        }, 1200);

        window.location.assign(cognitoUrl);
        return;
      }

      setTimeout(function () {
        setProgressWidth(55);
      }, 500);
      setTimeout(function () {
        setProgressWidth(85);
      }, 1100);
      setTimeout(function () {
        setProgressWidth(100);
      }, 1650);
      setTimeout(function () {
        onLoginSuccess();
      }, 2000);
    }

    return h(
      'div',
      {
        className:
          'relative min-h-screen w-full overflow-hidden honeycomb-animated-bg flex flex-col justify-between items-center px-4 py-5 sm:py-6',
      },
      h(BeeSwarmOverlay),
      h('div', { className: 'h-2 sm:h-4' }),
      h(
        'main',
        {
          className:
            'relative z-20 w-[85vw] max-w-[320px] sm:w-full sm:max-w-[440px] bg-white/95 backdrop-blur-md rounded-[24px] sm:rounded-[28px] shadow-[0_25px_60px_-15px_rgba(69,42,6,0.55)] border border-amber-100/80 px-5 py-7 sm:px-10 sm:py-11 flex flex-col items-center text-center transition-all duration-300',
        },
        !isLoading
          ? h(
              Fragment,
              null,
              h(
                'div',
                { className: 'relative flex items-center justify-center mb-6 sm:mb-8' },
                h('div', {
                  className:
                    'absolute w-32 h-32 sm:w-44 sm:h-44 rounded-full bg-amber-300/30 blur-2xl pointer-events-none',
                }),
                h('img', {
                  src: './assets/logo-login.png',
                  alt: 'BeeSense - Monitoreo Apícola IoT',
                  className: 'relative w-36 sm:w-52 h-auto object-contain select-none drop-shadow-sm',
                })
              ),
              h(
                'div',
                {
                  className:
                    'w-full max-w-[280px] sm:max-w-[340px] bg-slate-50/90 p-1.5 sm:p-2 rounded-2xl border border-slate-200/80 shadow-inner',
                },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: handleCognitoLogin,
                    className:
                      'group w-full flex items-center justify-center gap-2.5 sm:gap-3 px-4 py-2.5 sm:px-6 sm:py-3.5 rounded-xl bg-[#122B52] hover:bg-[#1a3a6b] active:scale-[0.99] text-white font-bold text-xs sm:text-sm border border-[#122B52] shadow-[0_4px_14px_rgba(18,43,82,0.18)] hover:shadow-[0_6px_20px_rgba(18,43,82,0.28)] hover:border-amber-400 transition-all duration-200',
                  },
                  h(
                    'svg',
                    {
                      className:
                        'w-4 h-4 sm:w-5 sm:h-5 text-amber-400 shrink-0 transition-transform group-hover:scale-110',
                      fill: 'none',
                      viewBox: '0 0 24 24',
                      stroke: 'currentColor',
                      strokeWidth: '2',
                    },
                    h('path', {
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                      d: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
                    })
                  ),
                  h('span', null, 'Iniciar sesión con correo')
                )
              )
            )
          : h(
              'div',
              { className: 'py-5 sm:py-7 px-2 w-full flex flex-col items-center justify-center space-y-4' },
              h(
                'div',
                { className: 'relative flex items-center justify-center' },
                h('div', {
                  className:
                    'w-20 h-20 sm:w-24 sm:h-24 rounded-full border-4 border-amber-100 border-t-amber-500 border-r-teal-500 animate-spin',
                }),
                h('img', {
                  src: './assets/logo-login.png',
                  alt: 'Cargando BeeSense',
                  className: 'absolute w-12 h-12 sm:w-14 sm:h-14 object-contain',
                })
              ),
              h('h2', { className: 'text-base sm:text-xl font-extrabold text-[#122B52]' }, 'Iniciando BeeSense IoT'),
              h(
                'div',
                {
                  className:
                    'w-full max-w-[220px] sm:max-w-xs bg-slate-100 h-2.5 rounded-full overflow-hidden p-0.5 border border-slate-200',
                },
                h('div', {
                  className:
                    'h-full rounded-full bg-gradient-to-r from-amber-500 via-amber-400 to-teal-500 transition-all duration-500 ease-out',
                  style: { width: progressWidth + '%' },
                })
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    setIsLoading(false);
                    setProgressWidth(20);
                    if (window.history && window.history.replaceState) {
                      window.history.replaceState(null, '', window.location.pathname);
                    }
                  },
                  className:
                    'mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-600 hover:text-[#122B52] bg-slate-100 hover:bg-slate-200/80 transition-all border border-slate-200/80 cursor-pointer',
                },
                h(
                  'svg',
                  {
                    className: 'w-3.5 h-3.5',
                    fill: 'none',
                    viewBox: '0 0 24 24',
                    stroke: 'currentColor',
                    strokeWidth: '2',
                  },
                  h('path', {
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                    d: 'M10 19l-7-7m0 0l7-7m-7 7h18',
                  })
                ),
                h('span', null, 'Volver a la pantalla principal')
              )
            )
      ),
      h(
        'footer',
        { className: 'relative z-20 mt-4 flex items-center justify-center text-center' },
        h(
          'div',
          {
            className:
              'inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#122B52]/85 backdrop-blur-sm text-amber-300 text-xs font-bold tracking-wide shadow-md border border-amber-300/30',
          },
          h('span', { className: 'w-2 h-2 rounded-full bg-teal-400' }),
          h('span', null, 'BeeSense 2026.')
        )
      )
    );
  }

  /* ==========================================================================
     6. BARRA LATERAL DE ESCRITORIO Y MENÚ HAMBURGUESA MÓVIL
     ========================================================================== */
  function Sidebar(props) {
    const activeTab = props.activeTab;
    const setActiveTab = props.setActiveTab;
    const eventsCount = props.eventsCount || 0;
    const darkMode = props.darkMode;
    const onToggleDarkMode = props.onToggleDarkMode;
    const onRequestLogout = props.onRequestLogout;

    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    const navItems = [
      { id: 'dashboard', label: 'Dashboard', icon: 'home' },
      { id: 'reportes', label: 'Reportes', icon: 'fileText', badge: eventsCount },
      { id: 'meteorologia', label: 'Meteorología', icon: 'cloudSun' },
      { id: 'cuenta', label: 'Mi Cuenta', icon: 'user' },
    ];

    function handleSelectTab(tabId) {
      setActiveTab(tabId);
      setMobileMenuOpen(false);
      try {
        window.location.hash = '#/' + (tabId === 'dashboard' ? 'dashboard' : tabId);
      } catch (e) {}
    }

    return h(
      Fragment,
      null,
      h(
        'header',
        {
          className:
            'flex md:hidden sticky top-0 z-30 w-full bg-white dark:bg-slate-900 border-b border-slate-200/80 dark:border-slate-800 px-4 py-3.5 items-center justify-between shadow-xs',
        },
        h(
          'button',
          {
            type: 'button',
            onClick: function () {
              setMobileMenuOpen(function (prev) {
                return !prev;
              });
            },
            'aria-label': 'Abrir menú hamburguesa',
            className:
              'relative p-2 -ml-1 rounded-xl text-[#122B52] dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all',
          },
          h(Icon, { name: mobileMenuOpen ? 'x' : 'menu', className: 'w-7 h-7', strokeWidth: 2.4 }),
          !mobileMenuOpen && eventsCount > 0
            ? h('span', {
                className:
                  'absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-slate-900',
              })
            : null
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: function () {
              handleSelectTab('dashboard');
            },
            className: 'flex items-center justify-center focus:outline-none',
          },
          h('img', {
            src: darkMode ? './assets/logo-mobile-dark.png' : './assets/logo-mobile.png',
            alt: 'BeeSense Logo',
            className: 'h-9 sm:h-10 w-auto object-contain select-none',
          })
        ),
        h('div', { className: 'w-9 h-9', 'aria-hidden': 'true' })
      ),
      h(
        'div',
        {
          className:
            'md:hidden fixed inset-0 z-50 transition-all duration-300 ' +
            (mobileMenuOpen ? 'visible pointer-events-auto' : 'invisible pointer-events-none'),
        },
        h('div', {
          className:
            'fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity duration-300 ' +
            (mobileMenuOpen ? 'opacity-100' : 'opacity-0'),
          onClick: function () {
            setMobileMenuOpen(false);
          },
        }),
        h(
          'aside',
          {
            className:
              'relative z-10 w-72 max-w-[82vw] bg-white dark:bg-slate-900 h-full flex flex-col justify-between shadow-2xl border-r border-slate-200 dark:border-slate-800 transform transition-transform duration-300 ease-out ' +
              (mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'),
          },
          h(
            'div',
            null,
            h(
              'div',
              {
                className:
                  'px-5 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between',
              },
              h('img', {
                src: darkMode ? './assets/logo-mobile-dark.png' : './assets/logo-mobile.png',
                alt: 'BeeSense Mobile Logo',
                className: 'h-9 w-auto object-contain',
              }),
              h(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    setMobileMenuOpen(false);
                  },
                  className:
                    'p-2 rounded-xl text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
                },
                h(Icon, { name: 'x', className: 'w-5 h-5' })
              )
            ),
            h(
              'nav',
              { className: 'p-4 space-y-2' },
              navItems.map(function (item) {
                const isActive = activeTab === item.id;
                return h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    onClick: function () {
                      handleSelectTab(item.id);
                    },
                    className:
                      'w-full flex items-center justify-between px-4 py-3.5 rounded-xl font-bold text-sm transition-all ' +
                      (isActive
                        ? 'bg-[#122B52] dark:bg-amber-500 text-white dark:text-slate-950 shadow-md'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'),
                  },
                  h(
                    'span',
                    { className: 'flex items-center gap-3.5' },
                    h(Icon, { name: item.icon, className: 'w-5 h-5' }),
                    h('span', null, item.label)
                  ),
                  item.badge > 0
                    ? h(
                        'span',
                        { className: 'px-2.5 py-0.5 text-xs font-extrabold rounded-full bg-red-500 text-white' },
                        item.badge
                      )
                    : null
                );
              })
            )
          ),
          h(
            'div',
            { className: 'p-4 border-t border-slate-100 dark:border-slate-800 space-y-2.5' },
            h(
              'button',
              {
                type: 'button',
                onClick: onToggleDarkMode,
                className:
                  'w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-semibold text-slate-700 dark:text-amber-300 bg-slate-100/90 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700',
              },
              h(
                'span',
                { className: 'flex items-center gap-3' },
                h(Icon, {
                  name: darkMode ? 'sun' : 'moon',
                  className: darkMode ? 'w-4 h-4 text-amber-400' : 'w-4 h-4 text-[#122B52]',
                }),
                h('span', null, darkMode ? 'Modo Claro' : 'Modo Oscuro')
              ),
              h(
                'span',
                {
                  className:
                    'w-8 h-4 flex items-center rounded-full p-0.5 transition-colors ' +
                    (darkMode ? 'bg-amber-500 justify-end' : 'bg-slate-300 justify-start'),
                },
                h('span', { className: 'w-3 h-3 rounded-full bg-white shadow-xs' })
              )
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  setMobileMenuOpen(false);
                  onRequestLogout();
                },
                className:
                  'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40',
              },
              h(Icon, { name: 'logOut', className: 'w-4 h-4' }),
              h('span', null, 'Cerrar Sesión')
            )
          )
        )
      ),
      h(
        'aside',
        {
          className:
            'hidden md:flex md:w-64 lg:w-72 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200/80 dark:border-slate-800 min-h-screen flex-col justify-between select-none transition-colors duration-300',
        },
        h(
          'div',
          null,
          h(
            'div',
            { className: 'px-6 py-7 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-center' },
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  setActiveTab('dashboard');
                },
                className: 'focus:outline-none group',
              },
              h('img', {
                src: darkMode ? './assets/logo-desktop-dark.png' : './assets/logo-desktop.png',
                alt: 'BeeSense - Monitoreo Apícola IoT',
                className: 'w-48 h-auto object-contain transition-transform duration-200 group-hover:scale-[1.02]',
              })
            )
          ),
          h(
            'nav',
            { className: 'px-4 py-6 space-y-2' },
            navItems.map(function (item) {
              const isActive = activeTab === item.id;
              return h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  onClick: function () {
                    handleSelectTab(item.id);
                  },
                  className:
                    'w-full flex items-center justify-between px-4 py-3.5 rounded-xl font-bold text-sm transition-all duration-200 ' +
                    (isActive
                      ? 'bg-[#122B52] dark:bg-amber-500 text-white dark:text-slate-950 shadow-[0_8px_20px_-4px_rgba(18,43,82,0.35)]'
                      : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-800 dark:hover:text-slate-200'),
                },
                h(
                  'span',
                  { className: 'flex items-center gap-3.5' },
                  h(Icon, { name: item.icon, className: 'w-5 h-5' }),
                  h('span', null, item.label)
                ),
                item.badge > 0
                  ? h(
                      'span',
                      { className: 'px-2.5 py-0.5 text-xs font-extrabold rounded-full bg-red-500 text-white shadow-xs' },
                      item.badge
                    )
                  : null
              );
            })
          )
        ),
        h(
          'div',
          { className: 'p-4 border-t border-slate-100 dark:border-slate-800 space-y-2.5' },
          h(
            'button',
            {
              type: 'button',
              onClick: onToggleDarkMode,
              className:
                'w-full flex items-center justify-between px-4 py-3 rounded-xl text-xs sm:text-sm font-semibold text-slate-700 dark:text-amber-300 bg-slate-100/90 dark:bg-slate-800/90 hover:bg-amber-50 dark:hover:bg-slate-800 border border-slate-200/70 dark:border-slate-700 transition-all',
            },
            h(
              'span',
              { className: 'flex items-center gap-3' },
              h(Icon, {
                name: darkMode ? 'sun' : 'moon',
                className: darkMode ? 'w-4 h-4 text-amber-400' : 'w-4 h-4 text-[#122B52]',
              }),
              h('span', null, darkMode ? 'Modo Claro' : 'Modo Oscuro')
            ),
            h(
              'span',
              {
                className:
                  'w-8 h-4 flex items-center rounded-full p-0.5 transition-colors ' +
                  (darkMode ? 'bg-amber-500 justify-end' : 'bg-slate-300 justify-start'),
              },
              h('span', { className: 'w-3 h-3 rounded-full bg-white shadow-xs' })
            )
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: onRequestLogout,
              className:
                'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors',
            },
            h(Icon, { name: 'logOut', className: 'w-4 h-4' }),
            h('span', null, 'Cerrar Sesión')
          )
        )
      )
    );
  }

  /* ==========================================================================
     7. GRÁFICO PANORÁMICO DE ÁREA SVG Y DASHBOARD DE PRODUCCIÓN
     ========================================================================== */
  function TemperatureTrendSVG(props) {
    const data = props.data || [];
    const darkMode = props.darkMode;
    const isOffline = Boolean(props.isOffline);
    const [hoverIdx, setHoverIdx] = useState(null);

    const yTicks = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
    const width = 860;
    const height = 320;
    const padLeft = 44;
    const padRight = 22;
    const padTop = 22;
    const padBottom = 34;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    function getX(i) {
      return padLeft + (i / Math.max(1, data.length - 1)) * plotW;
    }
    function getY(val) {
      return padTop + plotH - (Math.max(0, Math.min(50, Number(val) || 0)) / 50) * plotH;
    }
    const y36 = getY(36);

    const hasValidPoints =
      !isOffline &&
      data.some(function (d) {
        return (
          (d.interior !== null && d.interior !== undefined && !Number.isNaN(Number(d.interior))) ||
          (d.exterior !== null && d.exterior !== undefined && !Number.isNaN(Number(d.exterior)))
        );
      });

    // Construir segmentos conectados solo donde existan lecturas reales del Arduino
    const validIntEntries = !isOffline
      ? data
          .map(function (d, i) {
            return d.interior !== null && d.interior !== undefined && !Number.isNaN(Number(d.interior))
              ? { x: getX(i), y: getY(d.interior), val: Number(d.interior), idx: i }
              : null;
          })
          .filter(Boolean)
      : [];

    const validExtEntries = !isOffline
      ? data
          .map(function (d, i) {
            return d.exterior !== null && d.exterior !== undefined && !Number.isNaN(Number(d.exterior))
              ? { x: getX(i), y: getY(d.exterior), val: Number(d.exterior), idx: i }
              : null;
          })
          .filter(Boolean)
      : [];

    const intPoints = validIntEntries
      .map(function (pt) {
        return pt.x + ',' + pt.y;
      })
      .join(' ');
    const extPoints = validExtEntries
      .map(function (pt) {
        return pt.x + ',' + pt.y;
      })
      .join(' ');
    const intArea =
      validIntEntries.length >= 2
        ? validIntEntries[0].x +
          ',' +
          getY(0) +
          ' ' +
          intPoints +
          ' ' +
          validIntEntries[validIntEntries.length - 1].x +
          ',' +
          getY(0)
        : '';
    const extArea =
      validExtEntries.length >= 2
        ? validExtEntries[0].x +
          ',' +
          getY(0) +
          ' ' +
          extPoints +
          ' ' +
          validExtEntries[validExtEntries.length - 1].x +
          ',' +
          getY(0)
        : '';

    const activePoint =
      !isOffline &&
      hoverIdx !== null &&
      data[hoverIdx] &&
      (data[hoverIdx].interior !== null || data[hoverIdx].exterior !== null)
        ? data[hoverIdx]
        : null;

    return h(
      'div',
      { className: 'relative w-full' },
      activePoint
        ? h(
            'div',
            {
              className:
                'pointer-events-none mb-2 inline-flex flex-wrap items-center gap-4 px-4 py-2 rounded-xl bg-slate-900/90 text-white text-xs font-bold shadow-md',
            },
            h('span', { className: 'text-slate-300' }, 'Ventana horaria: ' + activePoint.time),
            activePoint.interior !== null && activePoint.interior !== undefined
              ? h(
                  'span',
                  { className: Number(activePoint.interior) > 36 ? 'text-red-400' : 'text-amber-300' },
                  'Temp. Interior: ' +
                    Number(activePoint.interior).toFixed(1) +
                    ' °C' +
                    (Number(activePoint.interior) > 36 ? ' (Umbral > 36°C)' : '')
                )
              : h('span', { className: 'text-slate-400' }, 'Temp. Interior: N/A'),
            activePoint.exterior !== null && activePoint.exterior !== undefined
              ? h(
                  'span',
                  { className: Number(activePoint.exterior) > 36 ? 'text-red-400' : 'text-teal-300' },
                  'Temp. Exterior: ' +
                    Number(activePoint.exterior).toFixed(1) +
                    ' °C' +
                    (Number(activePoint.exterior) > 36 ? ' (Umbral > 36°C)' : '')
                )
              : h('span', { className: 'text-slate-400' }, 'Temp. Exterior: N/A')
          )
        : null,
      h(
        'svg',
        {
          viewBox: '0 0 ' + width + ' ' + height,
          className: 'w-full h-[280px] sm:h-[340px] overflow-visible select-none',
          onMouseLeave: function () {
            setHoverIdx(null);
          },
        },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'prodGradInt', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#D99B26', stopOpacity: '0.42' }),
            h('stop', { offset: '100%', stopColor: '#D99B26', stopOpacity: '0.02' })
          ),
          h(
            'linearGradient',
            { id: 'prodGradExt', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#2A9D8F', stopOpacity: '0.32' }),
            h('stop', { offset: '100%', stopColor: '#2A9D8F', stopOpacity: '0.02' })
          ),
          h(
            'linearGradient',
            { id: 'prodGradRed', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#ef4444', stopOpacity: '0.54' }),
            h('stop', { offset: '100%', stopColor: '#ef4444', stopOpacity: '0.18' })
          ),
          h(
            'clipPath',
            { id: 'prodClipAbove36', clipPathUnits: 'userSpaceOnUse' },
            h('rect', { x: 0, y: 0, width: width, height: y36 })
          ),
          h(
            'clipPath',
            { id: 'prodClipBelow36', clipPathUnits: 'userSpaceOnUse' },
            h('rect', { x: 0, y: y36, width: width, height: height - y36 })
          )
        ),
        yTicks.map(function (t) {
          const y = getY(t);
          return h(
            'g',
            { key: t },
            h('line', {
              x1: padLeft,
              y1: y,
              x2: width - padRight,
              y2: y,
              stroke: darkMode ? '#1e293b' : '#f1f5f9',
              strokeDasharray: '3 3',
            }),
            h(
              'text',
              {
                x: padLeft - 10,
                y: y + 4,
                textAnchor: 'end',
                fontSize: 11,
                fontWeight: 600,
                fill: darkMode ? '#94a3b8' : '#64748b',
              },
              t + '°'
            )
          );
        }),
        h('line', {
          x1: padLeft,
          y1: y36,
          x2: width - padRight,
          y2: y36,
          stroke: '#ef4444',
          strokeWidth: 1.5,
          strokeDasharray: '4 4',
        }),
        h(
          'text',
          {
            x: width - padRight - 4,
            y: y36 - 5,
            textAnchor: 'end',
            fontSize: 10.5,
            fontWeight: 800,
            fill: '#ef4444',
          },
          'Umbral 36°C'
        ),
        hasValidPoints
          ? h(
              Fragment,
              null,
              h(
                'g',
                { clipPath: 'url(#prodClipBelow36)' },
                intArea ? h('polygon', { points: intArea, fill: 'url(#prodGradInt)' }) : null,
                extArea ? h('polygon', { points: extArea, fill: 'url(#prodGradExt)' }) : null,
                intPoints
                  ? h('polyline', { fill: 'none', stroke: '#D99B26', strokeWidth: 3.2, points: intPoints })
                  : null,
                extPoints
                  ? h('polyline', { fill: 'none', stroke: '#2A9D8F', strokeWidth: 3.2, points: extPoints })
                  : null
              ),
              h(
                'g',
                { clipPath: 'url(#prodClipAbove36)' },
                intArea ? h('polygon', { points: intArea, fill: 'url(#prodGradRed)' }) : null,
                extArea ? h('polygon', { points: extArea, fill: 'url(#prodGradRed)' }) : null,
                intPoints
                  ? h('polyline', { fill: 'none', stroke: '#ef4444', strokeWidth: 3.6, points: intPoints })
                  : null,
                extPoints
                  ? h('polyline', { fill: 'none', stroke: '#ef4444', strokeWidth: 3.6, points: extPoints })
                  : null
              )
            )
          : null,
        data.map(function (d, i) {
          const hasInt =
            !isOffline && d.interior !== null && d.interior !== undefined && !Number.isNaN(Number(d.interior));
          const hasExt =
            !isOffline && d.exterior !== null && d.exterior !== undefined && !Number.isNaN(Number(d.exterior));
          const isIntOver = hasInt && Number(d.interior) > 36;
          const isExtOver = hasExt && Number(d.exterior) > 36;
          const cx = getX(i);
          return h(
            'g',
            {
              key: d.time + i,
              onMouseEnter: function () {
                if (hasInt || hasExt) setHoverIdx(i);
              },
              className: hasInt || hasExt ? 'cursor-pointer' : 'cursor-default',
            },
            h('rect', {
              x: cx - plotW / Math.max(2, data.length * 2),
              y: padTop,
              width: plotW / Math.max(1, data.length),
              height: plotH,
              fill: 'transparent',
            }),
            hasInt
              ? h('circle', {
                  cx: cx,
                  cy: getY(d.interior),
                  r: isIntOver || hoverIdx === i ? 6 : 4.2,
                  fill: isIntOver ? '#ef4444' : '#D99B26',
                  stroke: '#ffffff',
                  strokeWidth: 1.8,
                })
              : null,
            isIntOver
              ? h(
                  'text',
                  {
                    x: cx,
                    y: getY(d.interior) - 10,
                    textAnchor: 'middle',
                    fontSize: 11,
                    fontWeight: 800,
                    fill: '#ef4444',
                  },
                  Number(d.interior).toFixed(1) + '°'
                )
              : null,
            hasExt
              ? h('circle', {
                  cx: cx,
                  cy: getY(d.exterior),
                  r: isExtOver || hoverIdx === i ? 6 : 4.2,
                  fill: isExtOver ? '#ef4444' : '#2A9D8F',
                  stroke: '#ffffff',
                  strokeWidth: 1.8,
                })
              : null,
            isExtOver
              ? h(
                  'text',
                  {
                    x: cx,
                    y: getY(d.exterior) - 10,
                    textAnchor: 'middle',
                    fontSize: 11,
                    fontWeight: 800,
                    fill: '#ef4444',
                  },
                  Number(d.exterior).toFixed(1) + '°'
                )
              : null,
            h(
              'text',
              {
                x: cx,
                y: height - 8,
                textAnchor: 'middle',
                fontSize: 11,
                fontWeight: 600,
                fill: darkMode ? '#94a3b8' : '#64748b',
              },
              d.time
            )
          );
        })
      ),
      !hasValidPoints
        ? h(
            'div',
            {
              className:
                'absolute inset-0 flex items-center justify-center pointer-events-none px-4 pb-6',
            },
            h(
              'div',
              {
                className:
                  'px-5 py-4 rounded-2xl bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 shadow-lg text-center max-w-md space-y-1',
              },
              h(
                'div',
                {
                  className:
                    'mx-auto w-9 h-9 rounded-full bg-rose-50 dark:bg-rose-950/60 text-rose-500 flex items-center justify-center mb-1.5',
                },
                h(Icon, { name: 'wifiOff', className: 'w-4 h-4' })
              ),
              h(
                'p',
                { className: 'text-xs sm:text-sm font-extrabold text-[#122B52] dark:text-white' },
                'Sin datos de telemetría en tiempo real (N/A)'
              ),
              h(
                'p',
                { className: 'text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed' },
                'El gráfico mostrará la curva de temperatura automáticamente cuando el dispositivo Arduino transmita lecturas activas.'
              )
            )
          )
        : null
    );
  }

  function DashboardView(props) {
    const telemetry = props.telemetry;
    const chartData = props.chartData || [];
    const darkMode = props.darkMode;
    const cfg = getRuntimeConfig();

    // Reevaluación periódica de caducidad (staleness) cada 5 segundos
    const [currentTimeMs, setCurrentTimeMs] = useState(Date.now);
    useEffect(function () {
      const timer = setInterval(function () {
        setCurrentTimeMs(Date.now());
      }, 5000);
      return function () {
        clearInterval(timer);
      };
    }, []);

    const st = evaluateTelemetryStatus(telemetry, currentTimeMs);
    const tempTicksBy5 = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

    const displayTempInt =
      st.tempStatus === 'NA' ? 'N/A' : Number(telemetry.tempInterior).toFixed(1) + '°C';
    const displayTempExt =
      st.climaExteriorStatus === 'NA' ? 'N/A' : Number(telemetry.tempExterior).toFixed(1) + '°C';
    const displayHumExt =
      st.climaExteriorStatus === 'NA' ? 'N/A' : Number(telemetry.humedadExterior).toFixed(1) + '%';
    const displayTapa =
      st.tapaStatus === 'NA'
        ? 'N/A'
        : String(telemetry.estadoTapa).toUpperCase() === 'ABIERTA'
        ? 'ABIERTA'
        : 'Cerrada';
    const displayBateria =
      st.bateriaStatus === 'NA' ? 'N/A' : Number(telemetry.bateria).toFixed(1) + '%';
    const batPct =
      st.bateriaStatus === 'NA' ? 0 : Math.max(0, Math.min(100, Number(telemetry.bateria)));
    const thermalDelta =
      st.tempStatus !== 'NA' && st.climaExteriorStatus !== 'NA'
        ? (Number(telemetry.tempInterior) - Number(telemetry.tempExterior)).toFixed(1)
        : null;

    const reversedChartData = chartData.slice().reverse();

    return h(
      'div',
      { className: 'w-full max-w-7xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-6' },
      h(
        'div',
        { className: 'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4' },
        h(
          'div',
          null,
          h(
            'h1',
            { className: 'text-2xl sm:text-3xl font-extrabold text-[#122B52] dark:text-white tracking-tight' },
            'Monitoreo en Tiempo Real'
          ),
          h(
            'p',
            { className: 'text-sm sm:text-base text-slate-500 dark:text-slate-400 font-medium mt-0.5' },
            cfg.nombreColmenar
          )
        ),
        h(
          'div',
          {
            className:
              'inline-flex items-center gap-2.5 px-4 py-2 rounded-full bg-white dark:bg-slate-900 border ' +
              (st.deviceOffline
                ? 'border-rose-300/80 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20'
                : st.anySensorDisconnected
                ? 'border-amber-300/80 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20'
                : 'border-slate-200/80 dark:border-slate-800') +
              ' shadow-xs self-start sm:self-auto',
          },
          h('span', {
            className:
              'w-2.5 h-2.5 rounded-full ' +
              (st.deviceOffline
                ? 'bg-rose-500 animate-pulse'
                : st.anySensorDisconnected
                ? 'bg-amber-500 animate-ping'
                : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]'),
          }),
          h(
            'span',
            {
              className:
                'text-xs sm:text-sm font-bold ' +
                (st.deviceOffline
                  ? 'text-rose-600 dark:text-rose-400'
                  : st.anySensorDisconnected
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-emerald-600 dark:text-emerald-400'),
            },
            st.deviceOffline
              ? 'Desconectado (N/A)'
              : st.anySensorDisconnected
              ? 'Alerta de Sensor (N/A)'
              : 'Sistema En Línea'
          )
        )
      ),
      st.deviceOffline
        ? h(
            'div',
            {
              className:
                'flex items-center gap-3 p-4 rounded-2xl bg-amber-50/90 dark:bg-amber-950/40 border border-amber-200/90 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 text-xs sm:text-sm shadow-xs',
            },
            h(Icon, {
              name: 'wifiOff',
              className: 'w-5 h-5 flex-shrink-0 text-amber-600 dark:text-amber-400',
            }),
            h(
              'div',
              { className: 'flex-1' },
              h('span', { className: 'font-bold' }, 'Hardware fuera de línea: '),
              'El nodo no está transmitiendo datos en tiempo real (apagado o sin conexión). ',
              st.secondsSinceLastReading !== null
                ? h(
                    'span',
                    {
                      className:
                        'block sm:inline sm:ml-2 text-[11px] text-amber-700 dark:text-amber-300 font-medium',
                    },
                    '(Última señal registrada: hace ' +
                      (st.secondsSinceLastReading > 3600
                        ? Math.floor(st.secondsSinceLastReading / 3600) + ' hora(s)'
                        : st.secondsSinceLastReading > 60
                        ? Math.floor(st.secondsSinceLastReading / 60) + ' minuto(s)'
                        : st.secondsSinceLastReading + ' s') +
                      ')'
                  )
                : null
            )
          )
        : null,
      h(
        'div',
        { className: 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5' },
        /* TARJETA 1: TEMPERATURA INTERIOR */
        h(
          'div',
          {
            className:
              'relative rounded-[22px] p-6 transition-all duration-300 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.07)] border ' +
              (st.tempStatus === 'LOW_BLINK_ALERT' || st.tempStatus === 'HIGH_ALERT'
                ? 'bg-[#FFF1F1] dark:bg-red-950/60 border-red-400 border-l-[6px] border-l-red-600 critical-blink-alert'
                : st.tempStatus === 'NA'
                ? 'bg-slate-100/90 dark:bg-slate-900 border-red-400 dark:border-red-700 border-l-[6px] border-l-red-500 na-blink-alert'
                : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 border-l-[6px] border-l-amber-400'),
          },
          h(
            'div',
            { className: 'flex items-center justify-between mb-5' },
            h(
              'div',
              {
                className:
                  'w-12 h-12 rounded-full flex items-center justify-center ' +
                  (st.tempStatus !== 'NORMAL'
                    ? 'bg-red-100 dark:bg-red-900/60 text-red-600 dark:text-red-300'
                    : 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400'),
              },
              h(Icon, {
                name: st.tempStatus === 'NA' ? 'wifiOff' : 'thermometer',
                className: 'w-6 h-6',
              })
            ),
            st.tempStatus !== 'NORMAL'
              ? h(Icon, { name: 'alertTriangle', className: 'w-5 h-5 text-red-500 dark:text-red-400' })
              : null
          ),
          h(
            'p',
            { className: 'text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1' },
            'TEMP. INTERIOR'
          ),
          h(
            'div',
            { className: 'flex items-baseline gap-2 flex-wrap' },
            h(
              'span',
              {
                className:
                  'text-3xl sm:text-4xl font-extrabold tracking-tight ' +
                  (st.tempStatus !== 'NORMAL'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-[#122B52] dark:text-white'),
              },
              displayTempInt
            ),
            st.tempStatus === 'HIGH_ALERT'
              ? h(
                  'span',
                  { className: 'text-[11px] font-bold uppercase px-2 py-0.5 rounded-md bg-red-600 text-white' },
                  'ALTA CRÍTICA'
                )
              : null,
            st.tempStatus === 'LOW_BLINK_ALERT'
              ? h(
                  'span',
                  { className: 'text-[11px] font-bold uppercase px-2 py-0.5 rounded-md bg-red-600 text-white' },
                  'BAJA CRÍTICA'
                )
              : null,
            st.tempStatus === 'NA'
              ? h(
                  'span',
                  { className: 'text-[11px] font-bold uppercase px-2 py-0.5 rounded-md bg-red-600 text-white' },
                  'SIN SEÑAL'
                )
              : null
          )
        ),
        /* TARJETA 2: CLIMA EXTERIOR */
        h(
          'div',
          {
            className:
              'relative rounded-[22px] p-6 transition-all duration-300 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.07)] border ' +
              (st.climaExteriorStatus === 'NA'
                ? 'bg-slate-100/90 dark:bg-slate-900 border-red-400 dark:border-red-700 border-l-[6px] border-l-red-500 na-blink-alert'
                : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 border-l-[6px] border-l-[#2A9D8F]'),
          },
          h(
            'div',
            { className: 'flex items-center justify-between mb-5' },
            h(
              'div',
              { className: 'flex items-center gap-2.5' },
              h(
                'div',
                {
                  className:
                    'w-12 h-12 rounded-full bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center',
                },
                h(Icon, { name: 'thermometer', className: 'w-6 h-6' })
              ),
              h(
                'div',
                {
                  className:
                    'w-12 h-12 rounded-full bg-teal-50 dark:bg-teal-950/60 text-[#2A9D8F] dark:text-teal-400 flex items-center justify-center',
                },
                h(Icon, { name: 'droplets', className: 'w-6 h-6' })
              )
            ),
            st.climaExteriorStatus === 'NA'
              ? h(Icon, { name: 'alertTriangle', className: 'w-5 h-5 text-red-500 dark:text-red-400' })
              : null
          ),
          h(
            'p',
            { className: 'text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1' },
            'CLIMA EXTERIOR'
          ),
          st.climaExteriorStatus === 'NA'
            ? h(
                'div',
                { className: 'flex items-baseline gap-2' },
                h('span', { className: 'text-3xl sm:text-4xl font-extrabold text-red-600 dark:text-red-400' }, 'N/A'),
                h(
                  'span',
                  { className: 'text-[11px] font-bold uppercase px-2 py-0.5 rounded-md bg-red-600 text-white' },
                  'SIN SEÑAL'
                )
              )
            : h(
                'div',
                { className: 'flex items-baseline gap-2.5 flex-wrap' },
                h(
                  'span',
                  { className: 'text-2xl sm:text-3xl font-extrabold text-[#122B52] dark:text-white' },
                  displayTempExt
                ),
                h('span', { className: 'text-slate-300 dark:text-slate-700 text-2xl font-light' }, '|'),
                h(
                  'span',
                  { className: 'text-xl sm:text-2xl font-bold text-[#2A9D8F] dark:text-teal-400' },
                  displayHumExt
                )
              )
        ),
        /* TARJETA 3: ESTADO TAPA */
        h(
          'div',
          {
            className:
              'relative rounded-[22px] p-6 transition-all duration-300 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.07)] border ' +
              (st.tapaStatus === 'OPEN_BLINK_ALERT'
                ? 'bg-[#FFF5EB] dark:bg-orange-950/55 border-orange-300 dark:border-orange-800 border-l-[6px] border-l-orange-500 critical-blink-alert'
                : st.tapaStatus === 'NA'
                ? 'bg-slate-100/90 dark:bg-slate-900 border-red-400 dark:border-red-700 border-l-[6px] border-l-red-500 na-blink-alert'
                : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 border-l-[6px] border-l-[#122B52] dark:border-l-amber-500'),
          },
          h(
            'div',
            { className: 'flex items-center justify-between mb-5' },
            h(
              'div',
              {
                className:
                  'w-12 h-12 rounded-full flex items-center justify-center ' +
                  (st.tapaStatus === 'OPEN_BLINK_ALERT'
                    ? 'bg-orange-100 dark:bg-orange-900/60 text-orange-600 dark:text-orange-300'
                    : st.tapaStatus === 'NA'
                    ? 'bg-red-100 dark:bg-red-950/70 text-red-600 dark:text-red-400'
                    : 'bg-slate-100 dark:bg-slate-800 text-[#122B52] dark:text-slate-200'),
              },
              h(Icon, {
                name:
                  st.tapaStatus === 'OPEN_BLINK_ALERT'
                    ? 'shieldAlert'
                    : st.tapaStatus === 'NA'
                    ? 'wifiOff'
                    : 'box',
                className: 'w-6 h-6',
              })
            ),
            st.tapaStatus === 'OPEN_BLINK_ALERT'
              ? h(
                  'span',
                  {
                    className:
                      'px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider bg-orange-600 text-white shadow-xs',
                  },
                  'ALERTA'
                )
              : null,
            st.tapaStatus === 'NA'
              ? h(
                  'span',
                  { className: 'px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase bg-red-600 text-white' },
                  'SIN SEÑAL'
                )
              : null
          ),
          h(
            'p',
            { className: 'text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1' },
            'ESTADO TAPA'
          ),
          h(
            'span',
            {
              className:
                'text-3xl sm:text-4xl font-extrabold tracking-tight ' +
                (st.tapaStatus === 'OPEN_BLINK_ALERT'
                  ? 'text-orange-600 dark:text-orange-400'
                  : st.tapaStatus === 'NA'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-[#122B52] dark:text-white'),
            },
            displayTapa
          )
        ),
        /* TARJETA 4: BATERÍA */
        h(
          'div',
          {
            className:
              'relative rounded-[22px] p-6 transition-all duration-300 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.07)] border ' +
              (st.bateriaStatus === 'CRITICAL_BLINK_10'
                ? 'bg-[#FFF1F1] dark:bg-red-950/60 border-red-400 border-l-[6px] border-l-red-600 critical-blink-alert'
                : st.bateriaStatus === 'LOW_ALERT_20'
                ? 'bg-[#FFF1F1] dark:bg-red-950/45 border-red-200 dark:border-red-800 border-l-[6px] border-l-red-500'
                : st.bateriaStatus === 'NA'
                ? 'bg-slate-100/90 dark:bg-slate-900 border-red-400 dark:border-red-700 border-l-[6px] border-l-red-500 na-blink-alert'
                : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 border-l-[6px] border-l-emerald-500'),
          },
          h(
            'div',
            { className: 'flex items-center justify-between mb-5' },
            h(
              'div',
              {
                className:
                  'w-12 h-12 rounded-full flex items-center justify-center ' +
                  (st.bateriaStatus !== 'NORMAL'
                    ? 'bg-red-100 dark:bg-red-900/60 text-red-600 dark:text-red-300'
                    : 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400'),
              },
              h(Icon, {
                name:
                  st.bateriaStatus === 'NA'
                    ? 'wifiOff'
                    : st.bateriaStatus !== 'NORMAL'
                    ? 'batteryWarning'
                    : 'battery',
                className: 'w-6 h-6',
              })
            ),
            st.bateriaStatus === 'NA'
              ? h(
                  'span',
                  { className: 'px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase bg-red-600 text-white' },
                  'SIN SEÑAL'
                )
              : null
          ),
          h(
            'p',
            { className: 'text-xs font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1' },
            'BATERÍA'
          ),
          h(
            'div',
            { className: 'flex items-center gap-3.5' },
            h(
              'span',
              {
                className:
                  'text-2xl sm:text-3xl font-extrabold tracking-tight ' +
                  (st.bateriaStatus !== 'NORMAL'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-[#122B52] dark:text-white'),
              },
              displayBateria
            ),
            st.bateriaStatus !== 'NA'
              ? h(
                  'div',
                  { className: 'flex-1 h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden' },
                  h('div', {
                    className:
                      'h-full rounded-full transition-all duration-500 ' +
                      (st.bateriaStatus !== 'NORMAL' ? 'bg-red-500' : 'bg-emerald-500'),
                    style: { width: batPct + '%' },
                  })
                )
              : null
          )
        )
      ),
      /* SECCIÓN GRÁFICO ADAPTATIVO (MOBILE BARRAS COMPARATIVAS vs ESCRITORIO ÁREA SVG) */
      h(
        'section',
        {
          className:
            'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-5 sm:p-8 shadow-[0_10px_30px_-10px_rgba(15,23,42,0.06)]',
        },
        h(
          'div',
          { className: 'flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6' },
          h(
            'div',
            null,
            h(
              'h2',
              { className: 'text-lg sm:text-xl font-extrabold text-[#122B52] dark:text-white' },
              'Tendencia de Temperatura'
            ),
            h(
              'p',
              { className: 'text-xs text-slate-400 dark:text-slate-500 font-medium' },
              'Ventanas horarias de 1 hora • Escala de 0°C a 50°C (de 5 en 5)'
            )
          ),
          h(
            'div',
            { className: 'flex flex-wrap items-center gap-4 text-xs sm:text-sm font-bold' },
            h(
              'div',
              { className: 'flex items-center gap-2 text-slate-600 dark:text-slate-300' },
              h('span', { className: 'w-3.5 h-3.5 rounded-full bg-[#D99B26]' }),
              h('span', null, 'Interior')
            ),
            h(
              'div',
              { className: 'flex items-center gap-2 text-slate-600 dark:text-slate-300' },
              h('span', { className: 'w-3.5 h-3.5 rounded-full bg-[#2A9D8F]' }),
              h('span', null, 'Exterior')
            ),
            h(
              'div',
              { className: 'flex items-center gap-2 text-red-600 dark:text-red-400' },
              h('span', { className: 'w-3.5 h-3.5 rounded-full bg-red-500' }),
              h('span', null, 'Umbral > 36°C')
            )
          )
        ),
        /* 1. VISTA MÓVIL */
        h(
          'div',
          { className: 'block md:hidden space-y-5' },
          h(
            'div',
            {
              className:
                'grid grid-cols-3 gap-2.5 p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200/70 dark:border-slate-700/70 text-center',
            },
            h(
              'div',
              null,
              h(
                'span',
                { className: 'block text-[10px] font-extrabold uppercase text-amber-600 dark:text-amber-400' },
                'Cámara Cría'
              ),
              h(
                'span',
                {
                  className:
                    'text-base font-extrabold ' +
                    (st.tempStatus !== 'NA' && Number(telemetry.tempInterior) > 36
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-[#122B52] dark:text-white'),
                },
                displayTempInt
              )
            ),
            h(
              'div',
              { className: 'border-x border-slate-200 dark:border-slate-700 px-1' },
              h(
                'span',
                { className: 'block text-[10px] font-extrabold uppercase text-teal-600 dark:text-teal-400' },
                'Exterior'
              ),
              h(
                'span',
                {
                  className:
                    'text-base font-extrabold ' +
                    (st.climaExteriorStatus !== 'NA' && Number(telemetry.tempExterior) > 36
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-[#122B52] dark:text-white'),
                },
                displayTempExt
              )
            ),
            h(
              'div',
              null,
              h('span', { className: 'block text-[10px] font-extrabold uppercase text-slate-400' }, 'Diferencial Δ'),
              h(
                'span',
                { className: 'text-base font-extrabold text-emerald-600 dark:text-emerald-400' },
                thermalDelta !== null ? (Number(thermalDelta) > 0 ? '+' : '') + thermalDelta + '°C' : 'N/A'
              )
            )
          ),
          h(
            'div',
            { className: 'space-y-3' },
            h(
              'div',
              { className: 'pl-14 pr-2' },
              h(
                'div',
                {
                  className:
                    'flex justify-between text-[10px] font-extrabold text-slate-400 dark:text-slate-500 pb-1 border-b border-slate-200 dark:border-slate-800',
                },
                tempTicksBy5.map(function (tick) {
                  return h('span', { key: tick }, tick + '°');
                })
              )
            ),
            st.deviceOffline
              ? h(
                  'div',
                  {
                    className:
                      'p-5 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700 text-center space-y-2',
                  },
                  h(
                    'div',
                    { className: 'w-10 h-10 mx-auto rounded-full bg-slate-200/70 dark:bg-slate-700/70 text-slate-500 dark:text-slate-400 flex items-center justify-center' },
                    h(Icon, { name: 'wifiOff', className: 'w-5 h-5' })
                  ),
                  h(
                    'p',
                    { className: 'text-xs sm:text-sm font-extrabold text-slate-700 dark:text-slate-200' },
                    'Sin datos de telemetría en tiempo real (N/A)'
                  ),
                  h(
                    'p',
                    { className: 'text-[11px] text-slate-400 dark:text-slate-500' },
                    'Las barras comparativas por cada ventana horaria de 1 hora se mostrarán cuando el dispositivo Arduino envíe datos.'
                  )
                )
              : null,
            h(
              'div',
              { className: 'space-y-3 max-h-[460px] overflow-y-auto pr-1' },
              reversedChartData.map(function (row, idx) {
                const hasInt = !st.deviceOffline && row.interior !== null && row.interior !== undefined && !isNaN(Number(row.interior));
                const hasExt = !st.deviceOffline && row.exterior !== null && row.exterior !== undefined && !isNaN(Number(row.exterior));
                const intVal = hasInt ? Number(row.interior) : null;
                const extVal = hasExt ? Number(row.exterior) : null;
                const intPct = hasInt ? Math.min(100, Math.max(0, (intVal / 50) * 100)) : 0;
                const extPct = hasExt ? Math.min(100, Math.max(0, (extVal / 50) * 100)) : 0;
                const isIntOver = hasInt && intVal > 36.0;
                const isExtOver = hasExt && extVal > 36.0;
                const isCrit = hasInt && (isIntOver || intVal < 15.0);

                return h(
                  'div',
                  {
                    key: row.time + idx,
                    className:
                      'p-3 rounded-2xl border transition-all ' +
                      (isIntOver || isExtOver
                        ? 'bg-red-50/70 dark:bg-red-950/35 border-red-300 dark:border-red-700 shadow-xs'
                        : idx === 0 && (hasInt || hasExt)
                        ? 'bg-amber-50/40 dark:bg-slate-800/90 border-amber-300/70 dark:border-amber-500/40 shadow-xs'
                        : 'bg-slate-50/60 dark:bg-slate-800/40 border-slate-100 dark:border-slate-800'),
                  },
                  h(
                    'div',
                    { className: 'flex items-center gap-3' },
                    h(
                      'div',
                      { className: 'w-12 shrink-0 text-center' },
                      h('span', { className: 'block text-xs font-extrabold text-[#122B52] dark:text-white' }, row.time),
                      idx === 0
                        ? h(
                            'span',
                            {
                              className:
                                'inline-block text-[9px] font-extrabold uppercase px-1.5 rounded ' +
                                (hasInt || hasExt
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400'),
                            },
                            hasInt || hasExt ? 'Actual' : 'N/A'
                          )
                        : null
                    ),
                    h(
                      'div',
                      { className: 'flex-1 space-y-2' },
                      h(
                        'div',
                        { className: 'space-y-0.5' },
                        h(
                          'div',
                          { className: 'flex justify-between text-xs font-bold' },
                          h(
                            'span',
                            {
                              className: isIntOver
                                ? 'text-red-600 dark:text-red-400 font-extrabold'
                                : 'text-amber-700 dark:text-amber-300',
                            },
                            'Interior'
                          ),
                          h(
                            'span',
                            {
                              className:
                                'font-extrabold ' +
                                (!hasInt
                                  ? 'text-slate-400 dark:text-slate-500'
                                  : isCrit
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-[#122B52] dark:text-white'),
                            },
                            hasInt ? intVal.toFixed(1) + '°C' : 'N/A'
                          )
                        ),
                        h(
                          'div',
                          {
                            className:
                              'relative w-full h-3.5 bg-slate-200/80 dark:bg-slate-700 rounded-full overflow-hidden',
                          },
                          h('div', {
                            className: 'absolute top-0 bottom-0 w-[2px] bg-red-500/80 z-10',
                            style: { left: '72%' },
                          }),
                          h('div', {
                            className:
                              'h-full rounded-full transition-all duration-500 ' +
                              (isCrit
                                ? 'bg-gradient-to-r from-red-500 to-red-600'
                                : 'bg-gradient-to-r from-amber-500 to-[#D99B26]'),
                            style: { width: intPct + '%' },
                          })
                        )
                      ),
                      h(
                        'div',
                        { className: 'space-y-0.5' },
                        h(
                          'div',
                          { className: 'flex justify-between text-xs font-bold' },
                          h(
                            'span',
                            {
                              className: isExtOver
                                ? 'text-red-600 dark:text-red-400 font-extrabold'
                                : 'text-teal-700 dark:text-teal-300',
                            },
                            'Exterior'
                          ),
                          h(
                            'span',
                            {
                              className:
                                'font-extrabold ' +
                                (!hasExt
                                  ? 'text-slate-400 dark:text-slate-500'
                                  : isExtOver
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-[#2A9D8F] dark:text-teal-400'),
                            },
                            hasExt ? extVal.toFixed(1) + '°C' : 'N/A'
                          )
                        ),
                        h(
                          'div',
                          {
                            className:
                              'relative w-full h-3 bg-slate-200/80 dark:bg-slate-700 rounded-full overflow-hidden',
                          },
                          h('div', {
                            className: 'absolute top-0 bottom-0 w-[2px] bg-red-500/50 z-10',
                            style: { left: '72%' },
                          }),
                          h('div', {
                            className:
                              'h-full rounded-full transition-all duration-500 ' +
                              (isExtOver
                                ? 'bg-gradient-to-r from-red-500 to-red-600'
                                : 'bg-gradient-to-r from-teal-500 to-[#2A9D8F]'),
                            style: { width: extPct + '%' },
                          })
                        )
                      )
                    )
                  )
                );
              })
            )
          )
        ),
        /* 2. VISTA DE ESCRITORIO */
        h(
          'div',
          { className: 'hidden md:block w-full' },
          h(TemperatureTrendSVG, { data: chartData, darkMode: darkMode, isOffline: st.deviceOffline })
        )
      )
    );
  }

  /* ==========================================================================
     8. VISTA DE REPORTES Y EXPORTACIÓN PDF
     ========================================================================== */
  const EVENT_TYPE_OPTIONS = [
    { value: 'TODOS', label: 'TODOS LOS EVENTOS' },
    { value: 'TEMPERATURA', label: 'TEMPERATURA' },
    { value: 'ALERTA CELULAR', label: 'ALERTA CELULAR (TAPA ABIERTA)' },
    { value: 'ESTADO DE BATERIA', label: 'ESTADO DE BATERIA' },
    { value: 'N/A', label: 'N/A' },
  ];

  function ReportsView(props) {
    const events = props.events || [];
    const cfg = getRuntimeConfig();

    const [fechaDesde, setFechaDesde] = useState('');
    const [fechaHasta, setFechaHasta] = useState('');
    const [tipoEvento, setTipoEvento] = useState('TODOS');
    const [rangoHorarioActivo, setRangoHorarioActivo] = useState(false);
    const [horaDesde, setHoraDesde] = useState('08:00');
    const [horaHasta, setHoraHasta] = useState('20:00');
    const [currentPage, setCurrentPage] = useState(1);
    const EVENTS_PER_PAGE = 15;

    const filteredEvents = useMemo(
      function () {
        return events.filter(function (ev) {
          if (ev.tipoEvento === 'ESTADO DE TAPADA') return false;
          if (tipoEvento !== 'TODOS' && ev.tipoEvento !== tipoEvento) return false;
          if (fechaDesde && ev.isoDate && ev.isoDate < fechaDesde) return false;
          if (fechaHasta && ev.isoDate && ev.isoDate > fechaHasta) return false;
          if (rangoHorarioActivo && horaDesde && horaHasta) {
            const evTime = getEventTimeHHMM(ev);
            if (horaDesde <= horaHasta) {
              if (evTime < horaDesde || evTime > horaHasta) return false;
            } else {
              if (evTime < horaDesde && evTime > horaHasta) return false;
            }
          }
          return true;
        });
      },
      [events, fechaDesde, fechaHasta, tipoEvento, rangoHorarioActivo, horaDesde, horaHasta]
    );

    useEffect(
      function () {
        setCurrentPage(1);
      },
      [fechaDesde, fechaHasta, tipoEvento, rangoHorarioActivo, horaDesde, horaHasta]
    );

    const totalPages = Math.max(1, Math.ceil(filteredEvents.length / EVENTS_PER_PAGE));
    const safePage = Math.min(currentPage, totalPages);
    const startIndex = (safePage - 1) * EVENTS_PER_PAGE;
    const endIndex = Math.min(startIndex + EVENTS_PER_PAGE, filteredEvents.length);
    const paginatedEvents = filteredEvents.slice(startIndex, endIndex);

    function getVisiblePageNumbers() {
      const pages = [];
      if (totalPages <= 7) {
        for (let i = 1; i <= totalPages; i++) pages.push(i);
        return pages;
      }
      pages.push(1);
      if (safePage > 3) pages.push('ellipsis-start');
      const start = Math.max(2, safePage - 1);
      const end = Math.min(totalPages - 1, safePage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (safePage < totalPages - 2) pages.push('ellipsis-end');
      pages.push(totalPages);
      return pages;
    }

    function handleResetFilters() {
      setFechaDesde('');
      setFechaHasta('');
      setTipoEvento('TODOS');
      setRangoHorarioActivo(false);
      setHoraDesde('08:00');
      setHoraHasta('20:00');
      setCurrentPage(1);
    }

    function handleDownloadPDF() {
      exportEventsToPDF(filteredEvents, {
        tipoEvento: tipoEvento,
        fechaDesde: fechaDesde || 'Inicio',
        fechaHasta: fechaHasta || 'Actualidad',
        rangoHorarioActivo: rangoHorarioActivo,
        horaDesde: horaDesde,
        horaHasta: horaHasta,
      });
    }

    function renderEventIcon(type) {
      if (type === 'TEMPERATURA') {
        return h(
          'div',
          {
            className:
              'w-10 h-10 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0',
          },
          h(Icon, { name: 'thermometer', className: 'w-5 h-5' })
        );
      }
      if (type === 'ESTADO DE TAPADA') {
        return h(
          'div',
          {
            className:
              'w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-950/60 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0',
          },
          h(Icon, { name: 'shieldAlert', className: 'w-5 h-5' })
        );
      }
      if (type === 'ALERTA CELULAR') {
        return h(
          'div',
          {
            className:
              'w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0',
          },
          h(Icon, { name: 'smartphone', className: 'w-5 h-5' })
        );
      }
      if (type === 'ESTADO DE BATERIA') {
        return h(
          'div',
          {
            className:
              'w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0',
          },
          h(Icon, { name: 'batteryWarning', className: 'w-5 h-5' })
        );
      }
      return h(
        'div',
        {
          className:
            'w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0',
        },
        h(Icon, { name: 'wifiOff', className: 'w-5 h-5' })
      );
    }

    return h(
      'div',
      { className: 'w-full max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-6' },
      h(
        'div',
        {
          className:
            'rounded-[24px] bg-[#16325B] dark:bg-[#0F2442] text-white p-6 sm:p-8 shadow-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border border-slate-700/40',
        },
        h(
          'div',
          null,
          h('h1', { className: 'text-2xl sm:text-3xl font-extrabold tracking-tight' }, 'Registro de Eventos'),
          h(
            'p',
            { className: 'text-xs sm:text-sm text-slate-300 mt-1' },
            'Historial de alertas y eventos críticos detectados por los sensores'
          )
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: handleDownloadPDF,
            className:
              'inline-flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-xs sm:text-sm border border-white/25 shadow-sm transition-all shrink-0',
          },
          h(Icon, { name: 'fileDown', className: 'w-4 h-4 text-amber-300' }),
          h('span', null, 'Exportar a PDF')
        )
      ),
      h(
        'div',
        {
          className:
            'rounded-[22px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 sm:p-6 shadow-xs space-y-4',
        },
        h(
          'div',
          { className: 'grid grid-cols-1 md:grid-cols-12 gap-4 items-end' },
          h(
            'div',
            { className: 'md:col-span-3 flex items-center gap-2.5 pb-2' },
            h(Icon, { name: 'calendar', className: 'w-5 h-5 text-amber-500 shrink-0' }),
            h('span', { className: 'text-sm font-extrabold text-[#122B52] dark:text-white block' }, 'Filtrar Eventos')
          ),
          h(
            'div',
            { className: 'md:col-span-3' },
            h(
              'label',
              { className: 'block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1.5' },
              'Tipo de Evento'
            ),
            h(
              'div',
              { className: 'relative' },
              h(Icon, {
                name: 'filter',
                className: 'w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none',
              }),
              h(
                'select',
                {
                  value: tipoEvento,
                  onChange: function (e) {
                    setTipoEvento(e.target.value);
                  },
                  className:
                    'w-full pl-9 pr-3 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500',
                },
                EVENT_TYPE_OPTIONS.map(function (opt) {
                  return h('option', { key: opt.value, value: opt.value }, opt.label);
                })
              )
            )
          ),
          h(
            'div',
            { className: 'md:col-span-2' },
            h('label', { className: 'block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1.5' }, 'Desde'),
            h('input', {
              type: 'date',
              value: fechaDesde,
              onChange: function (e) {
                setFechaDesde(e.target.value);
              },
              className:
                'w-full px-3 py-2.5 rounded-xl text-xs sm:text-sm font-medium bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500',
            })
          ),
          h(
            'div',
            { className: 'md:col-span-2' },
            h('label', { className: 'block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1.5' }, 'Hasta'),
            h('input', {
              type: 'date',
              value: fechaHasta,
              onChange: function (e) {
                setFechaHasta(e.target.value);
              },
              className:
                'w-full px-3 py-2.5 rounded-xl text-xs sm:text-sm font-medium bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500',
            })
          ),
          h(
            'div',
            { className: 'md:col-span-2' },
            h(
              'button',
              {
                type: 'button',
                onClick: handleResetFilters,
                className:
                  'w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors',
              },
              h(Icon, { name: 'rotateCcw', className: 'w-3.5 h-3.5' }),
              h('span', null, 'Limpiar')
            )
          )
        ),
        h(
          'div',
          {
            className:
              'pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4',
          },
          h(
            'div',
            { className: 'flex items-center gap-3' },
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': rangoHorarioActivo,
                onClick: function () {
                  setRangoHorarioActivo(function (prev) {
                    return !prev;
                  });
                },
                className:
                  'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ' +
                  (rangoHorarioActivo ? 'bg-[#2A9D8F]' : 'bg-slate-300 dark:bg-slate-700'),
              },
              h('span', {
                className:
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-200 ' +
                  (rangoHorarioActivo ? 'translate-x-5' : 'translate-x-0'),
              })
            ),
            h(
              'div',
              null,
              h(
                'div',
                { className: 'flex items-center gap-2' },
                h(
                  'span',
                  { className: 'text-xs sm:text-sm font-extrabold text-[#122B52] dark:text-white' },
                  'Filtrar por Rango Horario'
                ),
                h(
                  'span',
                  {
                    className:
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/70',
                  },
                  h(Icon, { name: 'zap', className: 'w-3 h-3' }),
                  h('span', null, 'Activación manual')
                )
              ),
              h(
                'p',
                { className: 'text-[11px] text-slate-400' },
                rangoHorarioActivo
                  ? 'Filtro horario activo: acotando registros dentro de la franja horaria seleccionada.'
                  : 'Actívelo manualmente cuando requiera acotar la búsqueda por franja horaria.'
              )
            )
          ),
          rangoHorarioActivo
            ? h(
                'div',
                {
                  className:
                    'flex flex-wrap items-center gap-3 bg-slate-50 dark:bg-slate-800/70 p-2.5 rounded-xl border border-slate-200/80 dark:border-slate-700',
                },
                h(
                  'div',
                  { className: 'flex items-center gap-2' },
                  h(Icon, { name: 'clock', className: 'w-4 h-4 text-[#2A9D8F]' }),
                  h('label', { className: 'text-xs font-bold text-slate-600 dark:text-slate-300' }, 'Hora Desde:'),
                  h('input', {
                    type: 'time',
                    value: horaDesde,
                    onChange: function (e) {
                      setHoraDesde(e.target.value);
                    },
                    className:
                      'px-2.5 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700',
                  })
                ),
                h(
                  'div',
                  { className: 'flex items-center gap-2' },
                  h('label', { className: 'text-xs font-bold text-slate-600 dark:text-slate-300' }, 'Hora Hasta:'),
                  h('input', {
                    type: 'time',
                    value: horaHasta,
                    onChange: function (e) {
                      setHoraHasta(e.target.value);
                    },
                    className:
                      'px-2.5 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700',
                  })
                )
              )
            : null
        )
      ),
      h(
        'div',
        {
          className:
            'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-xs overflow-hidden',
        },
        filteredEvents.length === 0
          ? h(
              'div',
              { className: 'p-12 text-center space-y-2' },
              h(
                'p',
                { className: 'text-base font-bold text-slate-600 dark:text-slate-300' },
                'No se encontraron eventos para los filtros seleccionados'
              ),
              h(
                'p',
                { className: 'text-xs text-slate-400' },
                'Los eventos críticos y alertas enviadas al celular aparecerán aquí automáticamente desde Amazon DynamoDB.'
              )
            )
          : h(
              Fragment,
              null,
              h(
                'div',
                {
                  className:
                    'hidden lg:grid lg:grid-cols-12 gap-4 px-6 py-3.5 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-800 text-[11px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400',
                },
                h('div', { className: 'col-span-3' }, 'Nombre de Colmenar'),
                h('div', { className: 'col-span-4' }, 'Evento y Detalle'),
                h('div', { className: 'col-span-2' }, 'Categoría'),
                h('div', { className: 'col-span-3 text-right' }, 'Inicio / Término')
              ),
              h(
                'div',
                { className: 'divide-y divide-slate-100 dark:divide-slate-800' },
                paginatedEvents.map(function (ev) {
                  const colmenarName = ev.nombreColmenar || cfg.nombreColmenar;
                  const isFinished = ev.fechaTermino && ev.fechaTermino !== 'En curso (Activa)';
                  return h(
                    'div',
                    {
                      key: ev.id,
                      className:
                        'p-4 sm:px-6 sm:py-5 grid grid-cols-1 lg:grid-cols-12 gap-3.5 lg:gap-4 items-start lg:items-center hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors',
                    },
                    h(
                      'div',
                      { className: 'lg:col-span-3 flex items-center gap-2.5' },
                      h(
                        'div',
                        {
                          className:
                            'w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0',
                        },
                        h(Icon, { name: 'mapPin', className: 'w-4 h-4' })
                      ),
                      h(
                        'div',
                        null,
                        h(
                          'span',
                          {
                            className:
                              'lg:hidden text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block',
                          },
                          'Nombre de Colmenar'
                        ),
                        h(
                          'span',
                          { className: 'text-xs sm:text-sm font-extrabold text-[#122B52] dark:text-amber-300' },
                          colmenarName
                        )
                      )
                    ),
                    h(
                      'div',
                      { className: 'lg:col-span-4 flex items-start sm:items-center gap-3.5' },
                      renderEventIcon(ev.tipoEvento),
                      h(
                        'div',
                        { className: 'space-y-0.5' },
                        h(
                          'h3',
                          { className: 'text-sm sm:text-base font-extrabold text-[#122B52] dark:text-white' },
                          ev.titulo
                        ),
                        h(
                          'p',
                          { className: 'text-xs sm:text-sm text-slate-600 dark:text-slate-300 font-medium' },
                          ev.detalle
                        )
                      )
                    ),
                    h(
                      'div',
                      { className: 'lg:col-span-2 flex items-center' },
                      h(
                        'span',
                        {
                          className:
                            'px-2.5 py-1 rounded-lg text-[11px] font-extrabold uppercase tracking-wider bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-amber-400 border border-slate-200/70 dark:border-slate-700',
                        },
                        ev.tipoEvento
                      )
                    ),
                    h(
                      'div',
                      {
                        className:
                          'lg:col-span-3 flex flex-col sm:flex-row lg:flex-col items-start sm:items-center lg:items-end gap-1.5',
                      },
                      h(
                        'div',
                        {
                          className:
                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[11px] font-semibold',
                        },
                        h(Icon, { name: 'clock', className: 'w-3.5 h-3.5 text-amber-500 shrink-0' }),
                        h('span', null, 'Inicio: ' + ev.fechaInicio)
                      ),
                      h(
                        'div',
                        {
                          className:
                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold ' +
                            (isFinished
                              ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/60'
                              : 'bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 border border-red-200/60 dark:border-red-800/60 animate-pulse'),
                        },
                        h(Icon, { name: 'checkCircle', className: 'w-3.5 h-3.5 shrink-0' }),
                        h('span', null, 'Término: ' + (ev.fechaTermino || 'En curso (Activa)'))
                      )
                    )
                  );
                })
              ),
              /* BARRA DE PAGINACIÓN (15 EVENTOS POR PÁGINA) */
              h(
                'div',
                {
                  className:
                    'px-4 sm:px-6 py-4 bg-slate-50/80 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4',
                },
                h(
                  'div',
                  { className: 'text-xs font-bold text-slate-500 dark:text-slate-400 text-center sm:text-left' },
                  'Mostrando ',
                  h('span', { className: 'font-extrabold text-[#122B52] dark:text-white' }, String(startIndex + 1)),
                  ' – ',
                  h('span', { className: 'font-extrabold text-[#122B52] dark:text-white' }, String(endIndex)),
                  ' de ',
                  h('span', { className: 'font-extrabold text-[#122B52] dark:text-white' }, String(filteredEvents.length)),
                  ' eventos (15 por página)'
                ),
                h(
                  'div',
                  { className: 'flex flex-wrap items-center justify-center gap-1.5' },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: safePage <= 1,
                      onClick: function () {
                        setCurrentPage(function (p) {
                          return Math.max(1, p - 1);
                        });
                      },
                      className:
                        'inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-extrabold border transition-all ' +
                        (safePage <= 1
                          ? 'bg-slate-100 dark:bg-slate-800/50 text-slate-400 dark:text-slate-600 border-slate-200/60 dark:border-slate-800 cursor-not-allowed'
                          : 'bg-white dark:bg-slate-800 text-[#122B52] dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:bg-amber-50 dark:hover:bg-slate-700 hover:border-amber-300 shadow-2xs'),
                    },
                    h(Icon, { name: 'chevronLeft', className: 'w-3.5 h-3.5' }),
                    h('span', null, 'Anterior')
                  ),
                  getVisiblePageNumbers().map(function (pageItem) {
                    if (typeof pageItem === 'string') {
                      return h(
                        'span',
                        {
                          key: pageItem,
                          className: 'px-2 py-1 text-xs font-extrabold text-slate-400 select-none',
                        },
                        '...'
                      );
                    }
                    const isActive = pageItem === safePage;
                    return h(
                      'button',
                      {
                        key: 'page-' + pageItem,
                        type: 'button',
                        onClick: function () {
                          setCurrentPage(pageItem);
                        },
                        className:
                          'min-w-[34px] h-[34px] px-2.5 rounded-xl text-xs font-extrabold border transition-all flex items-center justify-center ' +
                          (isActive
                            ? 'bg-[#122B52] dark:bg-amber-500 text-white dark:text-slate-950 border-[#122B52] dark:border-amber-400 shadow-sm'
                            : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:bg-amber-50 dark:hover:bg-slate-700 hover:border-amber-300'),
                      },
                      String(pageItem)
                    );
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: safePage >= totalPages,
                      onClick: function () {
                        setCurrentPage(function (p) {
                          return Math.min(totalPages, p + 1);
                        });
                      },
                      className:
                        'inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-extrabold border transition-all ' +
                        (safePage >= totalPages
                          ? 'bg-slate-100 dark:bg-slate-800/50 text-slate-400 dark:text-slate-600 border-slate-200/60 dark:border-slate-800 cursor-not-allowed'
                          : 'bg-white dark:bg-slate-800 text-[#122B52] dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:bg-amber-50 dark:hover:bg-slate-700 hover:border-amber-300 shadow-2xs'),
                    },
                    h('span', null, 'Siguiente'),
                    h(Icon, { name: 'chevronRight', className: 'w-3.5 h-3.5' })
                  )
                )
              )
            )
      )
    );
  }

  /* ==========================================================================
     9. VISTA DE METEOROLOGÍA Y CLIMA APÍCOLA (OPEN-METEO API)
     ========================================================================== */
  const CHILE_METEO_ZONES = [
    { id: 'melipilla', name: 'Melipilla (Región Metropolitana)', lat: -33.6892, lon: -71.2158 },
    { id: 'buin', name: 'Buin / Maipo (Región Metropolitana)', lat: -33.7328, lon: -70.7428 },
    { id: 'talagante', name: 'Talagante / Isla de Maipo (RM)', lat: -33.6639, lon: -70.9272 },
    { id: 'arica', name: 'Arica / Lluta (Arica y Parinacota)', lat: -18.4783, lon: -70.3126 },
    { id: 'vicuna', name: 'Valle de Elqui / Vicuña (Coquimbo)', lat: -30.0319, lon: -70.7081 },
    { id: 'ovalle', name: 'Ovalle / Limarí (Coquimbo)', lat: -30.5983, lon: -71.2003 },
    { id: 'san_felipe', name: 'San Felipe / Aconcagua (Valparaíso)', lat: -32.7507, lon: -70.7256 },
    { id: 'quillota', name: 'Quillota / Olmué (Valparaíso)', lat: -32.8797, lon: -71.2478 },
    { id: 'casablanca', name: 'Casablanca (Valparaíso)', lat: -33.3186, lon: -71.4089 },
    { id: 'rancagua', name: 'Rancagua / Cachapoal (O\'Higgins)', lat: -34.1708, lon: -70.7444 },
    { id: 'rengo', name: 'Rengo (O\'Higgins)', lat: -34.4069, lon: -70.8586 },
    { id: 'san_fernando', name: 'San Fernando / Colchagua (O\'Higgins)', lat: -34.5838, lon: -70.9889 },
    { id: 'santa_cruz', name: 'Santa Cruz (O\'Higgins)', lat: -34.6391, lon: -71.3644 },
    { id: 'curico', name: 'Curicó / Mataquito (Maule)', lat: -34.9828, lon: -71.2394 },
    { id: 'talca', name: 'Talca / Valle Central (Maule)', lat: -35.4264, lon: -71.6554 },
    { id: 'linares', name: 'Linares / Maule Sur (Maule)', lat: -35.8456, lon: -71.5978 },
    { id: 'cauquenes', name: 'Cauquenes (Maule)', lat: -35.9672, lon: -72.3156 },
    { id: 'san_carlos', name: 'San Carlos / Punilla (Ñuble)', lat: -36.4253, lon: -71.9583 },
    { id: 'chillan', name: 'Chillán / Valle de Itata (Ñuble)', lat: -36.6066, lon: -72.1034 },
    { id: 'los_angeles', name: 'Los Ángeles / Biobío (Biobío)', lat: -37.4697, lon: -72.3537 },
    { id: 'angol', name: 'Angol / Malleco (La Araucanía)', lat: -37.7981, lon: -72.7161 },
    { id: 'temuco', name: 'Temuco / Cautín (La Araucanía)', lat: -38.7359, lon: -72.5904 },
    { id: 'villarrica', name: 'Villarrica / Pucón (La Araucanía)', lat: -39.2822, lon: -72.2272 },
    { id: 'valdivia', name: 'Valdivia / Los Ríos (Los Ríos)', lat: -39.8142, lon: -73.2459 },
    { id: 'la_union', name: 'La Unión / Río Bueno (Los Ríos)', lat: -40.2942, lon: -73.0817 },
    { id: 'osorno', name: 'Osorno (Los Lagos)', lat: -40.5739, lon: -73.1335 },
    { id: 'frutillar', name: 'Frutillar / Llanquihue (Los Lagos)', lat: -41.1278, lon: -73.0578 },
    { id: 'puerto_montt', name: 'Puerto Montt (Los Lagos)', lat: -41.4693, lon: -72.9424 },
    { id: 'ancud', name: 'Ancud / Chiloé (Los Lagos)', lat: -41.8697, lon: -73.8267 },
    { id: 'coyhaique', name: 'Coyhaique (Aysén)', lat: -45.5712, lon: -72.0685 },
    { id: 'punta_arenas', name: 'Punta Arenas (Magallanes)', lat: -53.1638, lon: -70.9171 },
  ];

  function getOpenMeteoWmo(code) {
    const c = Number(code);
    if (c === 0) return { label: 'Cielo despejado', icon: 'cloudSun', color: 'text-amber-500' };
    if (c === 1) return { label: 'Principalmente despejado', icon: 'cloudSun', color: 'text-amber-500' };
    if (c === 2) return { label: 'Parcialmente nublado', icon: 'cloudSun', color: 'text-amber-600' };
    if (c === 3) return { label: 'Nublado cubierto', icon: 'cloud', color: 'text-slate-500' };
    if (c === 45 || c === 48) return { label: 'Neblina / Niebla', icon: 'cloud', color: 'text-slate-400' };
    if (c >= 51 && c <= 55) return { label: 'Llovizna leve', icon: 'cloudRain', color: 'text-blue-400' };
    if (c >= 56 && c <= 57) return { label: 'Llovizna engelante', icon: 'cloudRain', color: 'text-cyan-500' };
    if (c >= 61 && c <= 65) return { label: 'Lluvia moderada', icon: 'cloudRain', color: 'text-blue-500' };
    if (c >= 66 && c <= 67) return { label: 'Lluvia helada', icon: 'cloudRain', color: 'text-cyan-600' };
    if (c >= 71 && c <= 77) return { label: 'Nevada', icon: 'cloud', color: 'text-cyan-300' };
    if (c >= 80 && c <= 82) return { label: 'Chubascos de lluvia', icon: 'cloudRain', color: 'text-blue-600' };
    if (c >= 85 && c <= 86) return { label: 'Chubascos de nieve', icon: 'cloud', color: 'text-cyan-400' };
    if (c >= 95) return { label: 'Tormenta eléctrica', icon: 'cloudRain', color: 'text-purple-600' };
    return { label: 'Nubosidad variable', icon: 'cloudSun', color: 'text-amber-500' };
  }

  function getWindDirectionLabel(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '--';
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
    const idx = Math.round((deg % 360) / 22.5) % 16;
    return directions[idx];
  }

  function computeBeeFlightIndex(temp, windSpeed, precipitation) {
    if (temp === null || temp === undefined || isNaN(temp)) {
      return {
        status: 'unknown',
        badgeText: 'Sin datos',
        badgeBg: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
        border: 'border-slate-300 dark:border-slate-700',
        dotColor: 'bg-slate-400',
        title: 'Información meteorológica no disponible',
        desc: 'No se pudo evaluar el índice de vuelo apícola en este momento.',
      };
    }
    const t = Number(temp);
    const w = Number(windSpeed || 0);
    const p = Number(precipitation || 0);

    if (t < 12 || t > 36 || w >= 30 || p > 1) {
      const motivos = [];
      if (t < 12) motivos.push('baja temperatura (' + t.toFixed(1) + ' °C < 12 °C)');
      if (t > 36) motivos.push('calor excesivo (' + t.toFixed(1) + ' °C > 36 °C)');
      if (w >= 30) motivos.push('viento hostil (' + w.toFixed(1) + ' km/h ≥ 30 km/h)');
      if (p > 1) motivos.push('precipitaciones activas (' + p.toFixed(1) + ' mm)');

      return {
        status: 'restricted',
        badgeText: 'Vuelo Restringido / Crítico',
        badgeBg: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300',
        border: 'border-red-300 dark:border-red-800',
        dotColor: 'bg-red-500',
        title: 'Condiciones Adversas para Vuelo Apícola',
        desc:
          'El pecoreo se encuentra restringido por ' +
          motivos.join(', ') +
          '. Las abejas reducen drásticamente las salidas y priorizan la termorregulación interna del nido de cría.',
      };
    }

    if (t < 15 || t > 33 || w > 20 || p > 0) {
      const motivos = [];
      if (t < 15) motivos.push('temperatura fresca (' + t.toFixed(1) + ' °C)');
      if (t > 33) motivos.push('alta temperatura (' + t.toFixed(1) + ' °C)');
      if (w > 20) motivos.push('viento moderado (' + w.toFixed(1) + ' km/h)');
      if (p > 0) motivos.push('llovizna (' + p.toFixed(1) + ' mm)');

      return {
        status: 'moderate',
        badgeText: 'Vuelo Moderado / Cautela',
        badgeBg: 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
        border: 'border-amber-300 dark:border-amber-800',
        dotColor: 'bg-amber-500',
        title: 'Condiciones Aceptables con Precaución',
        desc:
          'Actividad de vuelo moderada debido a ' +
          motivos.join(', ') +
          '. Se recomienda supervisar apiarios expuestos y evitar revisiones invasivas si el viento supera los 20 km/h.',
      };
    }

    return {
      status: 'optimal',
      badgeText: 'Condiciones Óptimas de Pecoreo',
      badgeBg: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
      border: 'border-emerald-300 dark:border-emerald-800',
      dotColor: 'bg-emerald-500',
      title: 'Excelente Ventana Agro-Apícola',
      desc:
        'Temperatura óptima (' +
        t.toFixed(1) +
        ' °C), viento suave (' +
        w.toFixed(1) +
        ' km/h) y ausencia de lluvias. Ventana perfecta para pecoreo activo, recolección de polen, néctar y polinización.',
    };
  }

  function formatDailyDateCL(isoDateStr, index) {
    if (index === 0) return 'Hoy';
    if (index === 1) return 'Mañana';
    try {
      const parts = (isoDateStr || '').split('-');
      if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const d = new Date(year, month, day);
        const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const dayName = days[d.getDay()] || '';
        return dayName + ' ' + day + '/' + (month + 1);
      }
    } catch (e) {}
    return isoDateStr || '--';
  }

  function getDailyFlightBadge(maxTemp, minTemp, maxWind, rainProb) {
    if (maxTemp < 12 || maxWind >= 30 || rainProb >= 60) {
      return { label: 'Restringido', className: 'bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-300' };
    }
    if (maxTemp < 15 || maxTemp > 33 || maxWind > 20 || rainProb >= 30) {
      return { label: 'Moderado', className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300' };
    }
    return { label: 'Óptimo', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300' };
  }

  function MeteorologyView(props) {
    const [selectedZone, setSelectedZone] = useState(CHILE_METEO_ZONES[0]);
    const [weatherData, setWeatherData] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [gpsError, setGpsError] = useState(null);
    const [isLocating, setIsLocating] = useState(false);

    const fetchWeather = useCallback(function (lat, lon) {
      setIsLoading(true);
      setError(null);
      const url =
        'https://api.open-meteo.com/v1/forecast?latitude=' +
        encodeURIComponent(lat) +
        '&longitude=' +
        encodeURIComponent(lon) +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&timezone=auto';

      fetch(url)
        .then(function (res) {
          if (!res.ok) {
            throw new Error('Respuesta HTTP no exitosa: ' + res.status);
          }
          return res.json();
        })
        .then(function (data) {
          setWeatherData(data);
          setLastUpdated(new Date());
          setIsLoading(false);
        })
        .catch(function (err) {
          console.error('[BeeSense Meteo] Error al consultar Open-Meteo:', err);
          setError('No fue posible obtener el reporte meteorológico. Verifique su conexión a internet.');
          setIsLoading(false);
        });
    }, []);

    useEffect(
      function () {
        if (selectedZone && typeof selectedZone.lat === 'number' && typeof selectedZone.lon === 'number') {
          fetchWeather(selectedZone.lat, selectedZone.lon);
        }
      },
      [selectedZone, fetchWeather]
    );

    function handleZoneChange(e) {
      const zoneId = e.target.value;
      const found = CHILE_METEO_ZONES.find(function (z) {
        return z.id === zoneId;
      });
      if (found) {
        setGpsError(null);
        setSelectedZone(found);
      }
    }

    function handleGpsLocation() {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        setGpsError('La geolocalización no está disponible en este dispositivo o navegador.');
        return;
      }
      setIsLocating(true);
      setGpsError(null);
      navigator.geolocation.getCurrentPosition(
        function (position) {
          setIsLocating(false);
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          setSelectedZone({
            id: 'gps',
            name: 'Mi Ubicación Actual (GPS: ' + lat.toFixed(2) + '°, ' + lon.toFixed(2) + '°)',
            lat: lat,
            lon: lon,
          });
        },
        function (err) {
          setIsLocating(false);
          let msg = 'No se pudo obtener la ubicación GPS.';
          if (err.code === 1) msg = 'Permiso de geolocalización denegado en el navegador.';
          else if (err.code === 2) msg = 'Señal GPS no disponible.';
          else if (err.code === 3) msg = 'Tiempo de espera agotado al consultar GPS.';
          setGpsError(msg);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    }

    const current = weatherData && weatherData.current;
    const daily = weatherData && weatherData.daily;
    const currentWmo = current ? getOpenMeteoWmo(current.weather_code) : null;
    const flightStatus = current
      ? computeBeeFlightIndex(current.temperature_2m, current.wind_speed_10m, current.precipitation)
      : null;
    const windDir = current ? getWindDirectionLabel(current.wind_direction_10m) : '--';

    return h(
      'div',
      { className: 'w-full max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-6' },

      // Header Banner
      h(
        'div',
        {
          className:
            'rounded-[24px] bg-[#16325B] dark:bg-[#0F2442] text-white p-6 sm:p-8 shadow-lg flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6 border border-slate-700/40',
        },
        h(
          'div',
          { className: 'space-y-1.5' },
          h(
            'div',
            { className: 'flex items-center gap-2.5' },
            h(Icon, { name: 'cloudSun', className: 'w-7 h-7 text-amber-400 shrink-0' }),
            h(
              'h1',
              { className: 'text-2xl sm:text-3xl font-extrabold tracking-tight' },
              'Meteorología y Clima Apícola'
            )
          ),
          h(
            'p',
            { className: 'text-xs sm:text-sm text-slate-300 max-w-xl' },
            'Condiciones atmosféricas en tiempo real y pronóstico extendido a 7 días orientado al pecoreo y bienestar de las abejas.'
          )
        ),

        // Controls: Zone select + GPS + Refresh
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-3 shrink-0' },
          h(
            'div',
            { className: 'relative' },
            h(
              'select',
              {
                value: selectedZone.id,
                onChange: handleZoneChange,
                className:
                  'pl-3 pr-8 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-white/10 text-white border border-white/20 focus:outline-none focus:ring-2 focus:ring-amber-400 backdrop-blur-sm cursor-pointer',
              },
              selectedZone.id === 'gps'
                ? h('option', { value: 'gps', className: 'text-slate-900 bg-white' }, selectedZone.name)
                : null,
              CHILE_METEO_ZONES.map(function (zone) {
                return h(
                  'option',
                  {
                    key: zone.id,
                    value: zone.id,
                    className: 'text-slate-900 bg-white',
                  },
                  zone.name
                );
              })
            )
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: handleGpsLocation,
              disabled: isLocating,
              title: 'Obtener clima de mi ubicación actual vía GPS',
              className:
                'inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold text-xs sm:text-sm border border-white/20 transition-all disabled:opacity-50 cursor-pointer',
            },
            h(Icon, { name: 'navigation', className: 'w-4 h-4 text-emerald-400' }),
            h('span', null, isLocating ? 'Ubicando...' : 'Mi GPS')
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                if (selectedZone) fetchWeather(selectedZone.lat, selectedZone.lon);
              },
              disabled: isLoading,
              title: 'Actualizar reporte meteorológico',
              className:
                'inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-amber-500/90 hover:bg-amber-500 text-slate-950 font-bold text-xs sm:text-sm shadow-md transition-all disabled:opacity-50 cursor-pointer',
            },
            h(Icon, {
              name: 'refreshCw',
              className: 'w-4 h-4 ' + (isLoading ? 'animate-spin' : ''),
            }),
            h('span', null, 'Actualizar')
          )
        )
      ),

      // GPS Error Alert
      gpsError
        ? h(
            'div',
            {
              className:
                'flex items-center justify-between p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-xs sm:text-sm',
            },
            h(
              'div',
              { className: 'flex items-center gap-3' },
              h(Icon, { name: 'alertTriangle', className: 'w-5 h-5 text-amber-600 shrink-0' }),
              h('span', null, gpsError)
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  setGpsError(null);
                },
                className: 'text-amber-800 dark:text-amber-200 hover:opacity-75 font-bold',
              },
              'Entendido'
            )
          )
        : null,

      // Network / Fetch Error
      error
        ? h(
            'div',
            {
              className:
                'rounded-2xl p-6 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 flex flex-col sm:flex-row items-center justify-between gap-4',
            },
            h(
              'div',
              { className: 'flex items-center gap-3' },
              h(Icon, { name: 'wifiOff', className: 'w-6 h-6 text-red-600 shrink-0' }),
              h(
                'div',
                null,
                h('p', { className: 'font-bold text-sm' }, error),
                h(
                  'p',
                  { className: 'text-xs text-red-600/80 dark:text-red-300/80 mt-0.5' },
                  'Servicio satelital Open-Meteo temporalmente no accesible.'
                )
              )
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  if (selectedZone) fetchWeather(selectedZone.lat, selectedZone.lon);
                },
                className:
                  'px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs shadow-sm transition-all',
              },
              'Reintentar'
            )
          )
        : null,

      // Loading state
      isLoading && !weatherData
        ? h(
            'div',
            {
              className:
                'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-12 text-center shadow-sm',
            },
            h(Icon, {
              name: 'refreshCw',
              className: 'w-8 h-8 text-amber-500 animate-spin mx-auto mb-3',
            }),
            h(
              'p',
              { className: 'text-sm font-bold text-slate-700 dark:text-slate-300' },
              'Consultando pronóstico y telemetría climática para ' + selectedZone.name + '...'
            ),
            h(
              'p',
              { className: 'text-xs text-slate-400 mt-1' },
              'Conectando con Open-Meteo API en alta resolución'
            )
          )
        : null,

      // Weather Loaded Content
      weatherData && current
        ? h(
            Fragment,
            null,

            // Semáforo de Vuelo Apícola
            h(
              'div',
              {
                className:
                  'rounded-[24px] p-6 sm:p-7 border bg-white dark:bg-slate-900 shadow-sm transition-all ' +
                  (flightStatus ? flightStatus.border : 'border-slate-200 dark:border-slate-800'),
              },
              h(
                'div',
                { className: 'flex flex-col md:flex-row md:items-center md:justify-between gap-4' },
                h(
                  'div',
                  { className: 'space-y-2' },
                  h(
                    'div',
                    { className: 'flex items-center gap-3' },
                    h(
                      'span',
                      {
                        className:
                          'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider ' +
                          (flightStatus ? flightStatus.badgeBg : ''),
                      },
                      h('span', {
                        className:
                          'w-2 h-2 rounded-full animate-pulse ' +
                          (flightStatus ? flightStatus.dotColor : 'bg-slate-400'),
                      }),
                      flightStatus ? flightStatus.badgeText : 'Semáforo de Vuelo'
                    ),
                    h(
                      'span',
                      { className: 'text-xs text-slate-500 dark:text-slate-400 font-medium' },
                      'Zona: ' + selectedZone.name
                    )
                  ),
                  h(
                    'h2',
                    { className: 'text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white' },
                    flightStatus ? flightStatus.title : ''
                  ),
                  h(
                    'p',
                    { className: 'text-xs sm:text-sm text-slate-600 dark:text-slate-300 max-w-3xl leading-relaxed' },
                    flightStatus ? flightStatus.desc : ''
                  )
                ),
                lastUpdated
                  ? h(
                      'div',
                      { className: 'text-xs text-slate-500 dark:text-slate-400 text-left md:text-right shrink-0' },
                      h('p', null, 'Última actualización:'),
                      h(
                        'p',
                        { className: 'font-mono font-bold text-slate-700 dark:text-slate-200' },
                        lastUpdated.toLocaleTimeString('es-CL')
                      )
                    )
                  : null
              ),

              // Thresholds Bar
              h(
                'div',
                {
                  className:
                    'mt-5 pt-5 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs',
                },
                h(
                  'div',
                  {
                    className:
                      'p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 flex items-center justify-between',
                  },
                  h('span', { className: 'text-slate-500 dark:text-slate-400 font-medium' }, 'Rango Térmico de Pecoreo:'),
                  h('span', { className: 'font-bold text-slate-800 dark:text-slate-200' }, '15°C – 33°C')
                ),
                h(
                  'div',
                  {
                    className:
                      'p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 flex items-center justify-between',
                  },
                  h('span', { className: 'text-slate-500 dark:text-slate-400 font-medium' }, 'Límite de Viento Seguro:'),
                  h('span', { className: 'font-bold text-slate-800 dark:text-slate-200' }, '< 20 km/h')
                ),
                h(
                  'div',
                  {
                    className:
                      'p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 flex items-center justify-between',
                  },
                  h('span', { className: 'text-slate-500 dark:text-slate-400 font-medium' }, 'Tolerancia Precipitaciones:'),
                  h('span', { className: 'font-bold text-slate-800 dark:text-slate-200' }, '0 mm (Seco)')
                )
              )
            ),

            // 4 Real-time Metric Cards
            h(
              'div',
              { className: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6' },

              // Card 1: Temp & Sensación
              h(
                'div',
                {
                  className:
                    'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-5 shadow-sm space-y-3',
                },
                h(
                  'div',
                  { className: 'flex items-center justify-between' },
                  h('span', { className: 'text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide' }, 'Temperatura Exterior'),
                  h(
                    'div',
                    { className: 'w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center' },
                    h(Icon, { name: 'thermometer', className: 'w-5 h-5' })
                  )
                ),
                h(
                  'div',
                  null,
                  h(
                    'p',
                    { className: 'text-3xl font-extrabold text-slate-900 dark:text-white font-mono' },
                    Number(current.temperature_2m).toFixed(1) + '°C'
                  ),
                  h(
                    'p',
                    { className: 'text-xs text-slate-500 dark:text-slate-400 mt-1' },
                    'Sensación térmica: ' + Number(current.apparent_temperature).toFixed(1) + '°C'
                  )
                )
              ),

              // Card 2: Viento & Dirección
              h(
                'div',
                {
                  className:
                    'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-5 shadow-sm space-y-3',
                },
                h(
                  'div',
                  { className: 'flex items-center justify-between' },
                  h('span', { className: 'text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide' }, 'Viento en Superficie'),
                  h(
                    'div',
                    { className: 'w-9 h-9 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center' },
                    h(Icon, { name: 'wind', className: 'w-5 h-5' })
                  )
                ),
                h(
                  'div',
                  null,
                  h(
                    'p',
                    { className: 'text-3xl font-extrabold text-slate-900 dark:text-white font-mono' },
                    Number(current.wind_speed_10m).toFixed(1) + ' km/h'
                  ),
                  h(
                    'p',
                    { className: 'text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1.5' },
                    h(Icon, { name: 'compass', className: 'w-3.5 h-3.5 text-teal-600 dark:text-teal-400' }),
                    h('span', null, 'Rumbo ' + windDir + ' (' + current.wind_direction_10m + '°)')
                  )
                )
              ),

              // Card 3: Humedad & Presión
              h(
                'div',
                {
                  className:
                    'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-5 shadow-sm space-y-3',
                },
                h(
                  'div',
                  { className: 'flex items-center justify-between' },
                  h('span', { className: 'text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide' }, 'Humedad & Presión'),
                  h(
                    'div',
                    { className: 'w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center' },
                    h(Icon, { name: 'droplets', className: 'w-5 h-5' })
                  )
                ),
                h(
                  'div',
                  null,
                  h(
                    'p',
                    { className: 'text-3xl font-extrabold text-slate-900 dark:text-white font-mono' },
                    Math.round(current.relative_humidity_2m) + '%'
                  ),
                  h(
                    'p',
                    { className: 'text-xs text-slate-500 dark:text-slate-400 mt-1' },
                    'Presión: ' + Math.round(current.surface_pressure) + ' hPa'
                  )
                )
              ),

              // Card 4: Precipitación & Cielo
              h(
                'div',
                {
                  className:
                    'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-5 shadow-sm space-y-3',
                },
                h(
                  'div',
                  { className: 'flex items-center justify-between' },
                  h('span', { className: 'text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide' }, 'Precipitación Actual'),
                  h(
                    'div',
                    { className: 'w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center' },
                    h(Icon, { name: currentWmo ? currentWmo.icon : 'cloudRain', className: 'w-5 h-5' })
                  )
                ),
                h(
                  'div',
                  null,
                  h(
                    'p',
                    { className: 'text-3xl font-extrabold text-slate-900 dark:text-white font-mono' },
                    Number(current.precipitation).toFixed(1) + ' mm'
                  ),
                  h(
                    'p',
                    { className: 'text-xs font-semibold mt-1 ' + (currentWmo ? currentWmo.color : 'text-slate-500') },
                    currentWmo ? currentWmo.label : 'Variable'
                  )
                )
              )
            ),

            // 7-Day Extended Forecast
            daily && daily.time && daily.time.length > 0
              ? h(
                  'div',
                  {
                    className:
                      'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8 shadow-sm space-y-5',
                  },
                  h(
                    'div',
                    { className: 'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2' },
                    h(
                      'div',
                      null,
                      h(
                        'h3',
                        { className: 'text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white flex items-center gap-2' },
                        h(Icon, { name: 'calendar', className: 'w-5 h-5 text-amber-500' }),
                        'Pronóstico Agro-Apícola para 7 Días'
                      ),
                      h(
                        'p',
                        { className: 'text-xs text-slate-500 dark:text-slate-400 mt-1' },
                        'Planifique inspecciones del apiario, cosechas de miel y tratamientos sanitarios con anticipación.'
                      )
                    )
                  ),

                  h(
                    'div',
                    { className: 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3' },
                    daily.time.slice(0, 7).map(function (dateStr, idx) {
                      const code = daily.weather_code && daily.weather_code[idx];
                      const maxT = daily.temperature_2m_max && daily.temperature_2m_max[idx];
                      const minT = daily.temperature_2m_min && daily.temperature_2m_min[idx];
                      const rainP =
                        daily.precipitation_probability_max &&
                        daily.precipitation_probability_max[idx];
                      const windM =
                        daily.wind_speed_10m_max && daily.wind_speed_10m_max[idx];

                      const wmo = getOpenMeteoWmo(code);
                      const flightBadge = getDailyFlightBadge(maxT, minT, windM, rainP);

                      return h(
                        'div',
                        {
                          key: dateStr,
                          className:
                            'p-3.5 rounded-2xl bg-slate-50/80 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800/80 flex flex-col justify-between space-y-3 text-center transition-all hover:shadow-sm hover:border-slate-300 dark:hover:border-slate-700',
                        },
                        h(
                          'div',
                          { className: 'space-y-1' },
                          h(
                            'p',
                            { className: 'font-extrabold text-xs sm:text-sm text-slate-900 dark:text-white' },
                            formatDailyDateCL(dateStr, idx)
                          ),
                          h(
                            'div',
                            { className: 'flex justify-center py-1' },
                            h(Icon, { name: wmo.icon, className: 'w-7 h-7 ' + wmo.color })
                          ),
                          h(
                            'p',
                            { className: 'text-[11px] font-semibold text-slate-600 dark:text-slate-300 leading-tight line-clamp-1' },
                            wmo.label
                          )
                        ),

                        h(
                          'div',
                          { className: 'space-y-1 text-xs pt-1 border-t border-slate-200/60 dark:border-slate-700/60' },
                          h(
                            'div',
                            { className: 'flex items-center justify-between font-mono font-bold' },
                            h('span', { className: 'text-red-600 dark:text-red-400' }, Math.round(maxT) + '°'),
                            h('span', { className: 'text-slate-400' }, '/'),
                            h('span', { className: 'text-blue-600 dark:text-blue-400' }, Math.round(minT) + '°')
                          ),
                          h(
                            'div',
                            { className: 'flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400' },
                            h('span', null, 'Lluvia:'),
                            h('span', { className: 'font-bold text-blue-600 dark:text-blue-400' }, (rainP !== undefined && rainP !== null ? rainP : 0) + '%')
                          ),
                          h(
                            'div',
                            { className: 'flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400' },
                            h('span', null, 'Viento:'),
                            h('span', { className: 'font-bold' }, Math.round(windM) + 'k/h')
                          )
                        ),

                        h(
                          'span',
                          {
                            className:
                              'inline-block px-2 py-1 rounded-lg text-[10px] font-extrabold uppercase tracking-wide ' +
                              flightBadge.className,
                          },
                          flightBadge.label
                        )
                      );
                    })
                  )
                )
              : null,

            // Footer note
            h(
              'div',
              {
                className:
                  'rounded-2xl p-4 bg-slate-100/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-3',
              },
              h(Icon, { name: 'info', className: 'w-4 h-4 text-slate-400 shrink-0' }),
              h(
                'p',
                null,
                'Datos meteorológicos provistos por la API abierta de Open-Meteo (sin costo, cobertura satelital de alta resolución en tiempo real para Chile). Los índices de vuelo apícola son calculados según umbrales agronómicos estándar de pecoreo de ',
                h('em', null, 'Apis mellifera'),
                '.'
              )
            )
          )
        : null
    );
  }

  /* ==========================================================================
     10. VISTA DE PERFIL DEL APICULTOR (VALIDACIÓN DE AVATAR MÁX 600x600 PX)
     ========================================================================== */
  function ProfileView(props) {
    const avatarUrl = props.avatarUrl;
    const onUpdateAvatar = props.onUpdateAvatar;
    const authUser = props.authUser;

    const [uploadStatus, setUploadStatus] = useState(null);
    const fileInputRef = useRef(null);

    const displayName = (authUser && authUser.name) || 'Apicultor';
    const displayId = (authUser && authUser.id) || '15797764717598643303';
    const displayInitial =
      authUser && authUser.name
        ? String(authUser.name).trim().charAt(0).toUpperCase() || 'U'
        : 'U';

    function handleFileChange(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      if (file.type.indexOf('image/') !== 0) {
        setUploadStatus({
          type: 'error',
          message: 'Por favor seleccione un archivo de imagen válido (PNG, JPG o WEBP).',
        });
        return;
      }

      const reader = new FileReader();
      reader.onload = function (e) {
        const dataUrl = e.target && e.target.result;
        const img = new Image();
        img.onload = function () {
          if (img.width > 600 || img.height > 600) {
            setUploadStatus({
              type: 'error',
              message:
                'La imagen seleccionada mide ' +
                img.width +
                'x' +
                img.height +
                ' px. El tamaño máximo permitido es de 600x600 píxeles.',
            });
            return;
          }
          onUpdateAvatar(dataUrl);
          setUploadStatus({
            type: 'success',
            message: 'Avatar actualizado correctamente (' + img.width + 'x' + img.height + ' px).',
          });
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
      event.target.value = '';
    }

    return h(
      'div',
      { className: 'w-full max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-6' },
      h(
        'h1',
        { className: 'text-2xl sm:text-3xl font-extrabold text-[#122B52] dark:text-white tracking-tight' },
        'Mi Perfil'
      ),
      h(
        'div',
        {
          className:
            'rounded-[24px] bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-6 sm:p-8 shadow-[0_10px_30px_-10px_rgba(15,23,42,0.07)] flex flex-col sm:flex-row items-center sm:items-start justify-between gap-6',
        },
        h(
          'div',
          { className: 'flex flex-col sm:flex-row items-center gap-5 sm:gap-6 text-center sm:text-left' },
          h(
            'div',
            { className: 'relative group' },
            avatarUrl
              ? h('img', {
                  src: avatarUrl,
                  alt: 'Avatar Apicultor',
                  className:
                    'w-24 h-24 sm:w-28 sm:h-28 rounded-full object-cover border-4 border-teal-500/30 shadow-md',
                })
              : h(
                  'div',
                  {
                    className:
                      'w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-gradient-to-br from-[#122B52] via-[#1B4965] to-[#2A9D8F] text-white flex items-center justify-center text-4xl sm:text-5xl font-extrabold shadow-md select-none',
                  },
                  displayInitial
                ),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  if (fileInputRef.current) fileInputRef.current.click();
                },
                title: 'Cambiar imagen de avatar (máx. 600x600 px)',
                className:
                  'absolute bottom-0 right-0 w-9 h-9 rounded-full bg-[#122B52] hover:bg-amber-500 text-white hover:text-slate-950 flex items-center justify-center shadow-lg border-2 border-white dark:border-slate-900 transition-colors',
              },
              h(Icon, { name: 'camera', className: 'w-4 h-4' })
            ),
            h('input', {
              ref: fileInputRef,
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp',
              onChange: handleFileChange,
              className: 'hidden',
            })
          ),
          h(
            'div',
            { className: 'space-y-2.5' },
            h(
              'h2',
              { className: 'text-xl sm:text-2xl font-extrabold text-[#122B52] dark:text-white' },
              displayName
            ),
            authUser && authUser.email
              ? h('p', { className: 'text-xs font-semibold text-slate-500 dark:text-slate-400' }, authUser.email)
              : null,
            h(
              'div',
              {
                className:
                  'inline-block px-3 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-mono font-semibold',
              },
              'ID: ' + displayId
            ),
            h(
              'div',
              null,
              h(
                'span',
                {
                  className:
                    'inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/70 text-xs font-bold',
                },
                h('span', { className: 'w-2 h-2 rounded-full bg-emerald-500' }),
                h('span', null, 'Cuenta Activa y Sincronizada')
              )
            )
          )
        ),
        h(
          'div',
          { className: 'flex flex-col items-center sm:items-end gap-2 w-full sm:w-auto' },
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                if (fileInputRef.current) fileInputRef.current.click();
              },
              className:
                'w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-amber-500 hover:text-slate-950 text-slate-700 dark:text-slate-200 transition-colors',
            },
            h(Icon, { name: 'upload', className: 'w-3.5 h-3.5' }),
            h('span', null, 'Cambiar Avatar (Máx. 600×600 px)')
          ),
          avatarUrl
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    onUpdateAvatar(null);
                    setUploadStatus({
                      type: 'success',
                      message: 'Se ha restablecido el avatar predeterminado.',
                    });
                  },
                  className:
                    'inline-flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:underline',
                },
                h(Icon, { name: 'trash', className: 'w-3.5 h-3.5' }),
                h('span', null, 'Restaurar inicial')
              )
            : null
        )
      ),
      uploadStatus
        ? h(
            'div',
            {
              className:
                'rounded-2xl p-4 flex items-center gap-3 text-xs sm:text-sm font-semibold border ' +
                (uploadStatus.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                  : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'),
            },
            h(Icon, {
              name: uploadStatus.type === 'success' ? 'checkCircle' : 'alertTriangle',
              className:
                'w-5 h-5 shrink-0 ' +
                (uploadStatus.type === 'success' ? 'text-emerald-600' : 'text-red-600'),
            }),
            h('span', null, uploadStatus.message)
          )
        : null,
      h(
        'div',
        {
          className:
            'relative overflow-hidden rounded-[22px] bg-[#FEF8E8] dark:bg-amber-950/30 border border-[#F5E1A4] dark:border-amber-800/60 p-6 sm:p-8 shadow-xs',
        },
        h(
          'div',
          { className: 'relative z-10 space-y-2 max-w-2xl' },
          h(
            'h3',
            { className: 'text-base sm:text-lg font-extrabold text-[#854D0E] dark:text-amber-300' },
            'Información del Sistema'
          ),
          h(
            'p',
            { className: 'text-xs sm:text-sm text-[#92400E] dark:text-amber-200/90 leading-relaxed' },
            'Esta es la interfaz oficial de ',
            h('strong', { className: 'font-extrabold' }, 'BeeSense IoT'),
            '. Los colores, alertas y métricas están configurados para brindar un monitoreo claro e intenso del estado de los colmenares en tiempo real.'
          )
        )
      )
    );
  }

  /* ==========================================================================
     10. MODALES PRIORITARIOS DE ALERTA Y PIE DE PÁGINA INSTITUCIONAL
     ========================================================================== */
  function AlertModals(props) {
    const isHighTemp =
      props.tempValue !== null &&
      props.tempValue !== undefined &&
      Number(props.tempValue) > 36.0;

    return h(
      Fragment,
      null,
      /* 1. TAPA ABIERTA + "ENVIANDO SMS" */
      props.showLidModal
        ? h(
            'div',
            {
              className:
                'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/55 backdrop-blur-xs',
            },
            h(
              'div',
              {
                className:
                  'w-full max-w-[390px] rounded-[28px] bg-white dark:bg-slate-900 p-7 sm:p-8 text-center shadow-2xl border border-slate-100 dark:border-slate-800',
              },
              h(
                'div',
                {
                  className:
                    'mx-auto mb-5 w-16 h-16 rounded-full bg-orange-100/90 dark:bg-orange-950/80 text-orange-500 flex items-center justify-center',
                },
                h(Icon, { name: 'alertTriangle', className: 'w-8 h-8', strokeWidth: 2.2 })
              ),
              h(
                'h2',
                { className: 'text-xl sm:text-2xl font-extrabold text-[#122B52] dark:text-white mb-2.5' },
                '¡Alerta de Seguridad!'
              ),
              h(
                'p',
                { className: 'text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4' },
                'Se ha detectado que la tapa del colmenar principal se encuentra ',
                h('span', { className: 'font-extrabold text-orange-600 dark:text-orange-400' }, 'ABIERTA'),
                '.'
              ),
              h(
                'div',
                {
                  className:
                    'mb-6 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200/80 dark:border-indigo-800/70 text-xs font-extrabold tracking-wider text-indigo-700 dark:text-indigo-300',
                },
                h(Icon, { name: 'messageSms', className: 'w-4 h-4 shrink-0' }),
                h('span', null, 'ENVIANDO SMS')
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: props.onDismissLidModal,
                  className:
                    'w-full py-3.5 px-6 rounded-xl bg-[#122B52] hover:bg-[#1a3b6e] text-white font-bold text-sm shadow-md transition-all',
                },
                'Entendido'
              )
            )
          )
        : null,
      /* 2. TEMPERATURA CRÍTICA (> 36°C o < 15°C) */
      props.showTempModal && !props.showLidModal
        ? h(
            'div',
            {
              className:
                'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/55 backdrop-blur-xs',
            },
            h(
              'div',
              {
                className:
                  'w-full max-w-[390px] rounded-[28px] bg-white dark:bg-slate-900 p-7 sm:p-8 text-center shadow-2xl border border-slate-100 dark:border-slate-800',
              },
              h(
                'div',
                {
                  className:
                    'mx-auto mb-5 w-16 h-16 rounded-full bg-red-100/90 dark:bg-red-950/80 text-red-500 flex items-center justify-center',
                },
                h(Icon, { name: 'thermometer', className: 'w-8 h-8', strokeWidth: 2.2 })
              ),
              h(
                'h2',
                { className: 'text-xl sm:text-2xl font-extrabold text-[#122B52] dark:text-white mb-2.5' },
                '¡Alerta de Temperatura!'
              ),
              h(
                'p',
                { className: 'text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-7' },
                isHighTemp
                  ? h(
                      Fragment,
                      null,
                      'La temperatura interior de la colmena ha superado los ',
                      h(
                        'span',
                        { className: 'font-extrabold text-red-600 dark:text-red-400' },
                        '36°C (' + Number(props.tempValue).toFixed(1) + '°C)'
                      ),
                      '. Se requiere revisión inmediata en el colmenar.'
                    )
                  : h(
                      Fragment,
                      null,
                      'La temperatura interior de la colmena ha descendido a un nivel crítico ',
                      h(
                        'span',
                        { className: 'font-extrabold text-red-600 dark:text-red-400' },
                        '(' +
                          (props.tempValue !== null && props.tempValue !== undefined
                            ? Number(props.tempValue).toFixed(1) + '°C'
                            : 'Baja crítica') +
                          ')'
                      ),
                      '. Se requiere revisión inmediata en el colmenar.'
                    )
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: props.onDismissTempModal,
                  className:
                    'w-full py-3.5 px-6 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm shadow-md transition-all',
                },
                'Entendido'
              )
            )
          )
        : null,
      /* 3. SENSORES FUERA DE LÍNEA (N/A) */
      props.showSensorNAModal && !props.showLidModal && !props.showTempModal
        ? h(
            'div',
            {
              className:
                'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/55 backdrop-blur-xs',
            },
            h(
              'div',
              {
                className:
                  'w-full max-w-[390px] rounded-[28px] bg-white dark:bg-slate-900 p-7 sm:p-8 text-center shadow-2xl border border-slate-100 dark:border-slate-800',
              },
              h(
                'div',
                {
                  className:
                    'mx-auto mb-5 w-16 h-16 rounded-full bg-red-100/90 dark:bg-red-950/80 text-red-500 flex items-center justify-center',
                },
                h(Icon, { name: 'wifiOff', className: 'w-8 h-8', strokeWidth: 2.2 })
              ),
              h(
                'h2',
                { className: 'text-xl sm:text-2xl font-extrabold text-[#122B52] dark:text-white mb-2.5' },
                '¡Sensores Fuera de Línea!'
              ),
              h(
                'p',
                { className: 'text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-7' },
                'Se ha detectado pérdida de conexión ',
                h('span', { className: 'font-extrabold text-red-600 dark:text-red-400' }, '(N/A)'),
                ' en uno o más sensores del colmenar. Verifique el estado del nodo en terreno.'
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: props.onDismissSensorNAModal,
                  className:
                    'w-full py-3.5 px-6 rounded-xl bg-[#122B52] hover:bg-[#1a3b6e] text-white font-bold text-sm shadow-md transition-all',
                },
                'Entendido'
              )
            )
          )
        : null,
      /* 4. BATERÍA CRÍTICA (< 10%) */
      props.showBatteryModal &&
      !props.showLidModal &&
      !props.showTempModal &&
      !props.showSensorNAModal
        ? h(
            'div',
            {
              className:
                'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/55 backdrop-blur-xs',
            },
            h(
              'div',
              {
                className:
                  'w-full max-w-[390px] rounded-[28px] bg-white dark:bg-slate-900 p-7 sm:p-8 text-center shadow-2xl border border-slate-100 dark:border-slate-800',
              },
              h(
                'div',
                {
                  className:
                    'mx-auto mb-5 w-16 h-16 rounded-full bg-red-100/90 dark:bg-red-950/80 text-red-500 flex items-center justify-center',
                },
                h(Icon, { name: 'batteryWarning', className: 'w-8 h-8', strokeWidth: 2.2 })
              ),
              h(
                'h2',
                { className: 'text-xl sm:text-2xl font-extrabold text-[#122B52] dark:text-white mb-2.5' },
                '¡Batería Crítica!'
              ),
              h(
                'p',
                { className: 'text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-7' },
                'El nivel de batería ha caído por debajo del ',
                h(
                  'span',
                  { className: 'font-extrabold text-red-600 dark:text-red-400' },
                  '10%' +
                    (props.batteryValue !== null && props.batteryValue !== undefined
                      ? ' (' + Number(props.batteryValue).toFixed(1) + '%)'
                      : '')
                ),
                '. Es necesario revisión y recarga en el colmenar.'
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: props.onDismissBatteryModal,
                  className:
                    'w-full py-3.5 px-6 rounded-xl bg-red-500 hover:bg-red-600 text-white font-bold text-sm shadow-md transition-all',
                },
                'Entendido'
              )
            )
          )
        : null,
      /* 5. CONFIRMACIÓN DE CIERRE DE SESIÓN */
      props.showLogoutModal
        ? h(
            'div',
            {
              className:
                'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/55 backdrop-blur-xs',
            },
            h(
              'div',
              {
                className:
                  'w-full max-w-[390px] rounded-[28px] bg-white dark:bg-slate-900 p-7 sm:p-8 text-center shadow-2xl border border-slate-100 dark:border-slate-800',
              },
              h(
                'div',
                {
                  className:
                    'mx-auto mb-4 w-14 h-14 rounded-full bg-red-50 dark:bg-red-950/70 text-red-600 dark:text-red-400 flex items-center justify-center',
                },
                h(Icon, { name: 'logOut', className: 'w-7 h-7' })
              ),
              h(
                'h2',
                { className: 'text-xl font-extrabold text-[#122B52] dark:text-white mb-2' },
                '¿Cerrar Sesión?'
              ),
              h(
                'p',
                { className: 'text-sm text-slate-600 dark:text-slate-300 mb-6' },
                '¿Está seguro que desea finalizar su sesión actual en la plataforma ',
                h('strong', { className: 'font-bold' }, 'BeeSense IoT'),
                ' y volver a la pantalla de acceso?'
              ),
              h(
                'div',
                { className: 'grid grid-cols-2 gap-3' },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: props.onCancelLogout,
                    className:
                      'py-3 px-4 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-sm transition-colors',
                  },
                  'Cancelar'
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: props.onConfirmLogout,
                    className:
                      'py-3 px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm shadow-md transition-colors',
                  },
                  'Sí, cerrar sesión'
                )
              )
            )
          )
        : null
    );
  }

  function Footer() {
    return h(
      'footer',
      {
        className:
          'w-full py-4 px-6 border-t border-slate-200/70 dark:border-slate-800/80 bg-white/60 dark:bg-slate-900/60 backdrop-blur-xs flex items-center justify-center text-center',
      },
      h(
        'p',
        { className: 'text-xs font-bold tracking-wide text-slate-500 dark:text-slate-400' },
        'BeeSense 2026.'
      )
    );
  }

  /* ==========================================================================
     11. COMPONENTE RAÍZ DE PRODUCCIÓN (APP)
     ========================================================================== */
  function checkIsNotFoundRoute() {
    if (typeof window === 'undefined') return false;
    const hash = window.location.hash || '';
    if (isOAuthHash(hash)) return false;
    if (hash === '#/404' || (hash && VALID_HASH_ROUTES.indexOf(hash) === -1)) {
      return true;
    }
    const path = window.location.pathname || '/';
    const norm = (path.replace(/\/+$/, '') || '/').toLowerCase();
    const isKnown = norm === '/' || norm.slice(-11) === '/index.html';
    return !isKnown;
  }

  function App() {
    const initialSession = getStoredCognitoSession();
    const [authUser, setAuthUser] = useState(
      initialSession && initialSession.user ? initialSession.user : null
    );
    const [isAuthenticated, setIsAuthenticated] = useState(
      Boolean(initialSession && initialSession.token)
    );
    const [activeTab, setActiveTab] = useState(function () {
      try {
        const hash = typeof window !== 'undefined' ? (window.location.hash || '') : '';
        if (hash === '#/reportes') return 'reportes';
        if (hash === '#/meteorologia') return 'meteorologia';
        if (hash === '#/cuenta') return 'cuenta';
      } catch (e) {}
      return 'dashboard';
    });
    const [show404Page, setShow404Page] = useState(function () {
      return checkIsNotFoundRoute();
    });

    useEffect(function () {
      const stored = getStoredCognitoSession();
      if (stored && stored.token) {
        setAuthUser(stored.user);
        setIsAuthenticated(true);
        setShow404Page(false);
        return;
      }

      const cb = consumeCognitoCallbackFromUrl();
      if (cb && cb.token) {
        setAuthUser(cb.user);
        setIsAuthenticated(true);
        setShow404Page(false);
        return;
      }

      if (
        typeof window !== 'undefined' &&
        window.location.search &&
        (window.location.search.indexOf('error=') !== -1 ||
          window.location.search.indexOf('error_description=') !== -1)
      ) {
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname + (window.location.hash || ''));
        }
      }

      if (
        typeof window !== 'undefined' &&
        window.location.search &&
        window.location.search.indexOf('code=') !== -1
      ) {
        const searchParams = new URLSearchParams(window.location.search);
        const code = searchParams.get('code');
        if (code) {
          exchangeCognitoCodeForTokens(code).then(function (res) {
            if (res && res.token) {
              setAuthUser(res.user);
              setIsAuthenticated(true);
              setShow404Page(false);
            }
            if (window.history && window.history.replaceState) {
              window.history.replaceState(null, '', window.location.pathname + window.location.hash);
            }
          });
        }
      }
    }, []);

    useEffect(function () {
      function onRouteChange() {
        setShow404Page(checkIsNotFoundRoute());
        const hash = (typeof window !== 'undefined' && window.location.hash) || '';
        if (hash === '#/reportes') {
          setActiveTab('reportes');
        } else if (hash === '#/meteorologia') {
          setActiveTab('meteorologia');
        } else if (hash === '#/cuenta') {
          setActiveTab('cuenta');
        } else if (hash === '#/dashboard' || hash === '#/' || hash === '#' || hash === '') {
          setActiveTab('dashboard');
        }
      }
      window.addEventListener('hashchange', onRouteChange);
      window.addEventListener('popstate', onRouteChange);
      return function () {
        window.removeEventListener('hashchange', onRouteChange);
        window.removeEventListener('popstate', onRouteChange);
      };
    }, []);

    const [darkMode, setDarkMode] = useState(function () {
      try {
        return localStorage.getItem('beesense_dark_mode') === 'true';
      } catch (e) {
        return false;
      }
    });

    useEffect(
      function () {
        document.documentElement.classList.toggle('dark', darkMode);
        try {
          localStorage.setItem('beesense_dark_mode', String(darkMode));
        } catch (e) {}
      },
      [darkMode]
    );

    const [avatarUrl, setAvatarUrl] = useState(function () {
      try {
        return localStorage.getItem('beesense_avatar_url') || null;
      } catch (e) {
        return null;
      }
    });

    function handleUpdateAvatar(newUrl) {
      setAvatarUrl(newUrl);
      try {
        if (newUrl) localStorage.setItem('beesense_avatar_url', newUrl);
        else localStorage.removeItem('beesense_avatar_url');
      } catch (e) {}
    }

    const [hasLoadedInitialCloud, setHasLoadedInitialCloud] = useState(function () {
      return !getRuntimeConfig().apiBaseUrl;
    });

    const [telemetry, setTelemetry] = useState(function () {
      const cfg = getRuntimeConfig();
      if (cfg.productionMode || cfg.apiBaseUrl) {
        return {
          deviceId: cfg.colmenarId,
          tempInterior: null,
          tempExterior: null,
          humedadExterior: null,
          estadoTapa: 'N/A',
          bateria: null,
          timestamp: null,
          timestampMs: null,
          deviceOffline: true,
        };
      }
      return {
        deviceId: cfg.colmenarId,
        tempInterior: 34.2,
        tempExterior: 24.8,
        humedadExterior: 45.2,
        estadoTapa: 'Cerrada',
        bateria: 86.5,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        deviceOffline: false,
      };
    });

    const [chartData, setChartData] = useState(function () {
      const cfg = getRuntimeConfig();
      if (cfg.productionMode || cfg.apiBaseUrl) {
        return buildHourlySeries(null, null, true);
      }
      return buildHourlySeries(34.2, 24.8, false);
    });

    const [events, setEvents] = useState([]);
    const [seenEventIds, setSeenEventIds] = useState(function () {
      try {
        const saved = localStorage.getItem(SEEN_EVENTS_KEY);
        return saved ? JSON.parse(saved) : [];
      } catch (e) {
        return [];
      }
    });

    useEffect(
      function () {
        if (activeTab === 'reportes' && events.length > 0) {
          setSeenEventIds(function (prev) {
            const setObj = {};
            prev.forEach(function (id) {
              setObj[id] = true;
            });
            events.forEach(function (ev) {
              setObj[ev.id] = true;
            });
            const merged = Object.keys(setObj);
            if (merged.length !== prev.length) {
              try {
                localStorage.setItem(SEEN_EVENTS_KEY, JSON.stringify(merged));
              } catch (e) {}
              return merged;
            }
            return prev;
          });
        }
      },
      [activeTab, events]
    );

    const unreadEventsCount =
      activeTab === 'reportes'
        ? 0
        : events.filter(function (ev) {
            return seenEventIds.indexOf(ev.id) === -1;
          }).length;

    const [showLidModal, setShowLidModal] = useState(false);
    const [showTempModal, setShowTempModal] = useState(false);
    const [showSensorNAModal, setShowSensorNAModal] = useState(false);
    const [showBatteryModal, setShowBatteryModal] = useState(false);
    const [showLogoutModal, setShowLogoutModal] = useState(false);

    const activeEventsRef = useRef({
      TEMPERATURA: null,
      'ALERTA CELULAR': null,
      'ESTADO DE BATERIA': null,
      'N/A': null,
    });

    const shownModalEpisodeRef = useRef({
      TEMPERATURA: false,
      'ALERTA CELULAR': false,
      'ESTADO DE BATERIA': false,
      'N/A': false,
    });

    const sentSmsEpisodeRef = useRef({});

    const hydrateActiveEventsFromList = useCallback(function (list) {
      if (!Array.isArray(list)) return;
      const nextActive = {
        TEMPERATURA: null,
        'ALERTA CELULAR': null,
        'ESTADO DE BATERIA': null,
        'N/A': null,
      };
      for (let i = 0; i < list.length; i++) {
        const ev = list[i];
        if (
          ev &&
          ev.estadoEvento === 'ACTIVO' &&
          ev.tipoEvento in nextActive &&
          !nextActive[ev.tipoEvento]
        ) {
          nextActive[ev.tipoEvento] = ev.id;
        }
      }
      activeEventsRef.current = nextActive;
    }, []);

    useEffect(
      function () {
        if (!isAuthenticated) return;
        fetchEventsFromDynamoDB().then(function (loaded) {
          if (Array.isArray(loaded)) {
            hydrateActiveEventsFromList(loaded);
            setEvents(loaded);
          }
        });
      },
      [isAuthenticated, hydrateActiveEventsFromList]
    );

    const syncAnomaliesWithDynamoDB = useCallback(async function (currentTelemetry) {
      const cfg = getRuntimeConfig();
      const status = evaluateTelemetryStatus(currentTelemetry);
      const now = new Date();
      const formattedNow = formatDateTimeCL(now);
      const isoDate = toISODateString(now);
      const horaInicio24 = toTimeHHMM24(now);

      async function handleCategoryTransition(categoryKey, isAnomalyActive, buildPayload) {
        const currentActiveId = activeEventsRef.current[categoryKey];
        if (isAnomalyActive && !currentActiveId) {
          const newEventId =
            'EVT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
          activeEventsRef.current[categoryKey] = newEventId;
          const payload = Object.assign(
            {
              id: newEventId,
              nombreColmenar: cfg.nombreColmenar,
              tipoEvento: categoryKey,
              fechaInicio: formattedNow,
              fechaTermino: 'En curso (Activa)',
              isoDate: isoDate,
              horaInicio24: horaInicio24,
              estadoEvento: 'ACTIVO',
            },
            buildPayload()
          );
          const updatedList = await registerEventStartInDynamoDB(payload);
          setEvents(updatedList);
        } else if (!isAnomalyActive && currentActiveId) {
          activeEventsRef.current[categoryKey] = null;
          const updatedList = await registerEventEndInDynamoDB(
            currentActiveId,
            formattedNow,
            now.toISOString()
          );
          setEvents(updatedList);
        }
      }

      const isTempAnomaly =
        status.tempStatus === 'HIGH_ALERT' || status.tempStatus === 'LOW_BLINK_ALERT';
      if (isTempAnomaly && !shownModalEpisodeRef.current.TEMPERATURA) {
        shownModalEpisodeRef.current.TEMPERATURA = true;
        setShowTempModal(true);
      } else if (!isTempAnomaly) {
        shownModalEpisodeRef.current.TEMPERATURA = false;
      }
      await handleCategoryTransition('TEMPERATURA', isTempAnomaly, function () {
        return {
          titulo: 'Alerta Temperatura',
          detalle:
            status.tempStatus === 'HIGH_ALERT'
              ? 'Temperatura interior crítica alta: ' +
                Number(currentTelemetry.tempInterior).toFixed(1) +
                '°C (Umbral > 36°C)'
              : 'Temperatura interior crítica baja: ' +
                Number(currentTelemetry.tempInterior).toFixed(1) +
                '°C (Umbral < 15.0°C)',
        };
      });

      const isLidAnomaly = status.tapaStatus === 'OPEN_BLINK_ALERT';
      const lidEpisodeKey = String(
        (currentTelemetry && (currentTelemetry.timestamp || currentTelemetry.timestamp_unix || currentTelemetry.timestampMs)) ||
        'active'
      );

      if (isLidAnomaly && !shownModalEpisodeRef.current['ALERTA CELULAR']) {
        shownModalEpisodeRef.current['ALERTA CELULAR'] = true;
        setShowLidModal(true);
      } else if (!isLidAnomaly) {
        shownModalEpisodeRef.current['ALERTA CELULAR'] = false;
        sentSmsEpisodeRef.current = {};
      }

      const isStartingSms = isLidAnomaly && !sentSmsEpisodeRef.current[lidEpisodeKey];
      let smsResult = null;
      if (isStartingSms) {
        sentSmsEpisodeRef.current[lidEpisodeKey] = true;
        console.log('[BeeSense] Apertura detectada. Enviando alerta SMS para episodio:', lidEpisodeKey);
        smsResult = await dispatchRealSmsAlert({
          nombreColmenar: cfg.nombreColmenar,
          mensaje: 'ALERTA!!! Tapa de colmena abierta (' + cfg.nombreColmenar + ')',
        });
        console.log('[BeeSense] Resultado envío SMS:', smsResult);
      }
      await handleCategoryTransition('ALERTA CELULAR', isLidAnomaly, function () {
        return {
          titulo: 'Alerta Enviada al Celular',
          detalle:
            smsResult && smsResult.ok
              ? 'SMS enviado al celular ' +
                smsResult.telefonoMasked +
                (smsResult.messageId ? ' [ID: ' + smsResult.messageId + ']' : '') +
                ' por apertura de tapa de la colmena'
              : 'Notificación SMS enviada al celular del apicultor por apertura de tapa de la colmena',
        };
      });

      const isBatAnomaly = status.bateriaStatus === 'CRITICAL_BLINK_10';
      if (isBatAnomaly && !shownModalEpisodeRef.current['ESTADO DE BATERIA']) {
        shownModalEpisodeRef.current['ESTADO DE BATERIA'] = true;
        setShowBatteryModal(true);
      } else if (!isBatAnomaly) {
        shownModalEpisodeRef.current['ESTADO DE BATERIA'] = false;
      }
      await handleCategoryTransition('ESTADO DE BATERIA', isBatAnomaly, function () {
        return {
          titulo: 'Alerta Estado de Batería',
          detalle:
            'Nivel energético crítico (< ' +
            cfg.batteryAlertThreshold +
            '%) en nodo ' +
            cfg.colmenarId +
            ': ' +
            Number(currentTelemetry.bateria).toFixed(1) +
            '%',
        };
      });

      const isSensorNA = status.anySensorDisconnected;
      if (isSensorNA && !shownModalEpisodeRef.current['N/A']) {
        shownModalEpisodeRef.current['N/A'] = true;
        setShowSensorNAModal(true);
      } else if (!isSensorNA) {
        shownModalEpisodeRef.current['N/A'] = false;
      }
      await handleCategoryTransition('N/A', isSensorNA, function () {
        return {
          titulo: 'Alerta Sensor Sin Señal (N/A)',
          detalle:
            'Pérdida de conectividad (N/A) en: ' +
            describeDisconnectedSensors(currentTelemetry, status) +
            ' [Nodo ' +
            cfg.colmenarId +
            ']',
        };
      });
    }, []);

    useEffect(
      function () {
        if (isAuthenticated && hasLoadedInitialCloud) {
          syncAnomaliesWithDynamoDB(telemetry);
        }
      },
      [telemetry, isAuthenticated, hasLoadedInitialCloud, syncAnomaliesWithDynamoDB]
    );

    useEffect(
      function () {
        if (!isAuthenticated) return;
        const cfg = getRuntimeConfig();

        async function pullCloudData() {
          if (cfg.apiBaseUrl) {
            const result = await fetchLatestTelemetryFromAWS();
            if (result) {
              if (result.latest) {
                setTelemetry(result.latest);
                const latestSt = evaluateTelemetryStatus(result.latest);
                if (latestSt.deviceOffline) {
                  setChartData(buildHourlySeries(null, null, true));
                } else if (result.historySeries && result.historySeries.length > 0) {
                  setChartData(result.historySeries);
                }
              } else {
                setTelemetry({
                  deviceId: cfg.colmenarId,
                  tempInterior: null,
                  tempExterior: null,
                  humedadExterior: null,
                  estadoTapa: 'N/A',
                  bateria: null,
                  timestamp: null,
                  timestampMs: null,
                  deviceOffline: true,
                });
                setChartData(buildHourlySeries(null, null, true));
              }
              if (Array.isArray(result.events)) {
                hydrateActiveEventsFromList(result.events);
                setEvents(result.events);
                setHasLoadedInitialCloud(true);
                return;
              }
            } else {
              setTelemetry(function (prev) {
                return Object.assign({}, prev, { deviceOffline: true });
              });
              setChartData(buildHourlySeries(null, null, true));
            }
            const remoteEvents = await fetchEventsFromDynamoDB();
            if (Array.isArray(remoteEvents)) {
              hydrateActiveEventsFromList(remoteEvents);
              setEvents(remoteEvents);
            }
            setHasLoadedInitialCloud(true);
          }
        }

        pullCloudData();
        const interval = setInterval(pullCloudData, cfg.pollingIntervalMs);
        const disconnectWss = connectAwsIotWebSocket(function (livePayload) {
          setTelemetry(livePayload);
          setHasLoadedInitialCloud(true);
        });

        return function () {
          clearInterval(interval);
          disconnectWss();
        };
      },
      [isAuthenticated]
    );

    useEffect(
      function () {
        const stNow = evaluateTelemetryStatus(telemetry);
        if (!stNow.deviceOffline && (telemetry.tempInterior !== null || telemetry.tempExterior !== null)) {
          setChartData(function (prev) {
            const next = prev.slice();
            if (next.length > 0) {
              const dt = telemetry.timestamp ? new Date(telemetry.timestamp) : new Date();
              const hourSlot = isNaN(dt.getTime())
                ? next[next.length - 1].time
                : String(dt.getHours()).padStart(2, '0') + ':00';
              next[next.length - 1] = Object.assign({}, next[next.length - 1], {
                time: hourSlot || next[next.length - 1].time,
                interior:
                  telemetry.tempInterior !== null && telemetry.tempInterior !== undefined && !isNaN(Number(telemetry.tempInterior))
                    ? Number(telemetry.tempInterior)
                    : next[next.length - 1].interior,
                exterior:
                  telemetry.tempExterior !== null && telemetry.tempExterior !== undefined && !isNaN(Number(telemetry.tempExterior))
                    ? Number(telemetry.tempExterior)
                    : next[next.length - 1].exterior,
              });
            }
            return next;
          });
        }
      },
      [telemetry.tempInterior, telemetry.tempExterior, telemetry.timestamp, telemetry.deviceOffline]
    );

    if (show404Page) {
      return h(NotFound404Screen, {
        darkMode: darkMode,
        isAuthenticated: isAuthenticated,
        onReturnHome: function () {
          window.history.replaceState(null, '', '/');
          setShow404Page(false);
        },
      });
    }

    if (!isAuthenticated) {
      return h(LoginScreen, {
        onLoginSuccess: function () {
          setIsAuthenticated(true);
        },
      });
    }

    return h(
      'div',
      {
        className:
          'min-h-screen flex flex-col md:flex-row bg-[#F4F7FB] dark:bg-slate-950 text-slate-800 dark:text-slate-100 transition-colors duration-300',
      },
      h(Sidebar, {
        activeTab: activeTab,
        setActiveTab: setActiveTab,
        eventsCount: unreadEventsCount,
        darkMode: darkMode,
        onToggleDarkMode: function () {
          setDarkMode(function (prev) {
            return !prev;
          });
        },
        onRequestLogout: function () {
          setShowLogoutModal(true);
        },
      }),
      h(
        'div',
        { className: 'flex-1 flex flex-col min-h-screen overflow-x-hidden' },
        h(
          'main',
          { className: 'flex-1' },
          activeTab === 'dashboard'
            ? h(DashboardView, {
                telemetry: telemetry,
                chartData: chartData,
                darkMode: darkMode,
              })
            : null,
          activeTab === 'reportes' ? h(ReportsView, { events: events }) : null,
          activeTab === 'meteorologia'
            ? h(MeteorologyView, { darkMode: darkMode })
            : null,
          activeTab === 'cuenta'
            ? h(ProfileView, {
                avatarUrl: avatarUrl,
                onUpdateAvatar: handleUpdateAvatar,
                authUser: authUser,
              })
            : null
        ),
        h(Footer)
      ),
      h(AlertModals, {
        showLidModal: showLidModal,
        onDismissLidModal: function () {
          setShowLidModal(false);
        },
        showTempModal: showTempModal,
        tempValue: telemetry.tempInterior,
        onDismissTempModal: function () {
          setShowTempModal(false);
        },
        showSensorNAModal: showSensorNAModal,
        onDismissSensorNAModal: function () {
          setShowSensorNAModal(false);
        },
        showBatteryModal: showBatteryModal,
        batteryValue: telemetry.bateria,
        onDismissBatteryModal: function () {
          setShowBatteryModal(false);
        },
        showLogoutModal: showLogoutModal,
        onCancelLogout: function () {
          setShowLogoutModal(false);
        },
        onConfirmLogout: function () {
          setShowLogoutModal(false);
          setIsAuthenticated(false);
          setAuthUser(null);
          setActiveTab('dashboard');
          const logoutUrl = clearCognitoSession();
          if (logoutUrl) {
            window.location.assign(logoutUrl);
          }
        },
      })
    );
  }

  const rootEl = document.getElementById('root');
  if (rootEl) {
    ReactDOM.createRoot(rootEl).render(h(App));
  }
})();
