const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
const javascript = stripTypeScriptTypes(source, { mode: 'transform' });
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};
const httpError = (status, code) => ({ response: { status, data: { payload: { code } } } });
const tokenResponse = (access_token = 'fresh-access') => ({ data: { access_token, expires_in: 3600 } });

// Execute the real module through ESM linking. Only its external dependencies are mocked;
// no production method bodies are extracted or rewritten for these tests.
async function fixture(options = {}) {
    const logs = [], delays = [], posts = [], gets = [], responses = [], devices = new Map();
    const handlers = new Map(), deviceHandlers = new Map(), supportedTypes = new Map();
    const values = { pairedUserId: 'account-a', tokenInfo: { refresh_token: 'refresh-a' }, syncedDevices: [], ...options.values };
    let validate = options.validate || (async () => ({ data: { id: 'account-a', clientId: 'amazon', expiry: Date.now() + 60000 } }));
    let post = options.post || (async url => url.endsWith('/token') ? tokenResponse() : { status: 202 });
    const logger = Object.fromEntries(['debug', 'warn', 'error', 'info', 'log'].map(name => [name, (...args) => logs.push(args)]));
    const sdk = { systemManager: {
        getDeviceById: id => devices.get(id),
        getSystemState: () => Object.fromEntries([...devices.keys()].map(id => [id, {}])),
        listen: () => {},
    }, deviceManager: {} };
    class Base {
        constructor() {
            this.id = 'alexa'; this.console = logger;
            this.log = { a: message => logs.push([message]), i: () => {}, clearAlerts: () => {} };
        }
    }
    class StorageSettings {
        constructor(device, settings) {
            this.values = new Proxy(values, { set(target, key, value) {
                const oldValue = target[key]; target[key] = value;
                settings[key]?.onPut?.(oldValue, value);
                return true;
            } });
        }
        putSetting(key, value) { this.values[key] = value; return Promise.resolve(); }
    }
    const symbols = ['HttpRequest', 'HttpRequestHandler', 'MixinProvider', 'ScryptedDevice', 'EventDetails', 'Setting', 'SettingValue', 'Settings', 'HttpResponseOptions', 'HttpResponse'];
    const sdkExports = { default: sdk, ScryptedDeviceBase: Base,
        ScryptedDeviceType: new Proxy({}, { get: (_, key) => key }),
        ScryptedInterface: new Proxy({}, { get: (_, key) => key }),
        ...Object.fromEntries(symbols.map(name => [name, undefined])),
    };
    const errorResponse = (type, message, directive) => ({ event: { header: { ...directive.header, name: 'ErrorResponse' }, payload: { type, message } } });
    const dependencies = {
        axios: { default: {
            get: async (...args) => { gets.push(args); return validate(...args); },
            post: async (...args) => { posts.push(args); return post(...args); },
        } },
        '@scrypted/sdk': sdkExports,
        '@scrypted/sdk/storage-settings': { StorageSettings },
        './common': { addOnline: x => x, deviceErrorResponse: errorResponse, authErrorResponse: errorResponse,
            mirroredResponse: () => ({}), AlexaHttpResponse: undefined },
        './types': { supportedTypes },
        uuid: { v4: () => 'message-id' },
        './alexa': { ChangeReport: undefined, Discovery: undefined, DiscoveryEndpoint: undefined },
        './handlers': { alexaHandlers: handlers, alexaDeviceHandlers: deviceHandlers },
        './types/camera/handlers': { setUseTurnServer: () => {} },
    };
    const context = vm.createContext({ console: logger, process: { env: {} }, URLSearchParams, Buffer,
        setTimeout: (callback, delay) => {
            delays.push(delay);
            if (delay < 10000) queueMicrotask(callback);
            return 0;
        },
    });
    const module = new vm.SourceTextModule(javascript, { context });
    await module.link(async name => {
        assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
        const exports = dependencies[name];
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    const Plugin = module.namespace.default;
    Plugin.prototype.start = async () => {};
    const plugin = new Plugin();
    plugin.getAlexaEndpoint = async () => 'api.amazonalexa.com';
    let operations = 0;
    deviceHandlers.set('Alexa.PowerController/TurnOn', async () => { operations++; });
    devices.set('switch', { id: 'switch', mixins: ['alexa'], type: 'Switch' });
    const request = async authorization => plugin.onRequest({
        headers: authorization === undefined ? {} : { authorization },
        body: JSON.stringify({ directive: { header: { namespace: 'Alexa.PowerController', name: 'TurnOn', payloadVersion: '3' }, endpoint: { endpointId: 'switch' }, payload: {} } }),
    }, { send: body => responses.push(JSON.parse(body)) });
    return { plugin, values, posts, gets, responses, delays, logs, devices, request, supportedTypes,
        get operations() { return operations; },
        setPost: fn => post = fn, setValidate: fn => validate = fn };
}

const endpointEvent = () => ({ event: { header: { messageId: 'stable-id' }, endpoint: { scope: { type: 'BearerToken', token: 'stale' } }, payload: {} } });
const discoveryEvent = () => ({ event: { header: { messageId: 'stable-id' }, payload: { scope: { type: 'BearerToken', token: 'stale' } } } });

test('every directive revalidates the token, including a previously accepted token', async () => {
    const f = await fixture();
    await f.request('token-a'); await f.request('token-a');
    assert.equal(f.gets.length, 2); assert.equal(f.operations, 2);
    f.setValidate(async () => { throw httpError(401); });
    await f.request('token-a');
    assert.equal(f.operations, 2);
    assert.equal(f.responses.at(-1).event.payload.type, 'INVALID_AUTHORIZATION_CREDENTIAL');
});
test('pairing replacement invalidates old credentials and rejects the old identity', async () => {
    const f = await fixture(); await f.request('token-a');
    await f.plugin.putSetting('pairedUserId', 'account-b');
    assert.equal(f.values.tokenInfo, undefined);
    await f.request('token-a'); assert.equal(f.operations, 1);
});
test('clearing and re-pairing requires validation and accepts only the new account', async () => {
    const f = await fixture(); await f.plugin.putSetting('pairedUserId', '');
    f.setValidate(async () => ({ data: { id: 'account-b', clientId: 'amazon' } }));
    await f.request('token-b'); assert.equal(f.values.pairedUserId, 'account-b');
    f.setValidate(async () => ({ data: { id: 'account-a', clientId: 'amazon' } }));
    await f.request('token-a'); assert.equal(f.operations, 1);
});
test('pairing changes while cloud validation is pending reject the in-flight request', async () => {
    const pending = deferred(); const f = await fixture({ validate: () => pending.promise });
    const request = f.request('token-a');
    await f.plugin.putSetting('pairedUserId', '');
    pending.resolve({ data: { id: 'account-a', clientId: 'amazon' } });
    await request; assert.equal(f.operations, 0); assert.equal(f.values.pairedUserId, '');
});
test('missing authorization, wrong client, missing identity and expired tokens are rejected', async () => {
    const f = await fixture(); await f.request(undefined); assert.equal(f.gets.length, 0);
    for (const data of [
        { id: 'account-a', clientId: 'google' },
        { clientId: 'amazon' },
        { id: 'account-a', clientId: 'amazon', expiry: 1 },
        { id: 'account-a', clientId: 'amazon', expiry: 'invalid' },
        { id: 'account-a', clientId: 'amazon', expiry: Date.now() - 1000 },
    ]) { f.setValidate(async () => ({data})); await f.request('token-a'); }
    assert.equal(f.operations, 0);
});
test('legacy tokens and future second, millisecond and ISO expiries are supported', async () => {
    const f = await fixture();
    for (const expiry of [undefined, Math.floor(Date.now()/1000)+60, Date.now()+60000, new Date(Date.now()+60000).toISOString()]) {
        f.setValidate(async () => ({data:{id:'account-a', ...(expiry === undefined ? {} : {expiry,clientId:'amazon'})}}));
        await f.request('token-a');
    }
    assert.equal(f.operations, 4);
});
test('refresh responses that omit a refresh token preserve the previous token', async () => {
    const f = await fixture();
    assert.equal(await f.plugin.getAccessToken(), 'fresh-access');
    assert.equal(f.values.tokenInfo.refresh_token, 'refresh-a');
});
test('authorization-code exchange drops the consumed code and stores the issued refresh token', async () => {
    const f = await fixture({values:{tokenInfo:{code:'grant-code'}},post:async()=>({data:{access_token:'access',refresh_token:'issued-refresh',expires_in:3600}})});
    await f.plugin.getAccessToken();
    assert.equal(new URLSearchParams(f.posts[0][1]).get('grant_type'), 'authorization_code');
    assert.equal(f.values.tokenInfo.code, undefined);
    assert.equal(f.values.tokenInfo.refresh_token, 'issued-refresh');
});
test('401 refreshes once and replaces HTTP and endpoint scope tokens', async () => {
    const f = await fixture(); f.plugin.accessToken = Promise.resolve('old-access');
    let events = 0;
    f.setPost(async url => url.endsWith('/token') ? tokenResponse() : (++events === 1 ? Promise.reject(httpError(401)) : {status:202}));
    const event = endpointEvent(); await f.plugin.postEvent(event);
    const requests = f.posts.filter(([url]) => url.endsWith('/events'));
    assert.equal(requests[1][2].headers.Authorization, 'Bearer fresh-access');
    assert.equal(requests[1][1].event.endpoint.scope.token, 'fresh-access');
    assert.equal(event.event.endpoint.scope.token, 'stale');
    assert.equal(f.values.tokenInfo.refresh_token, 'refresh-a');
});
test('discovery scope uses the refreshed token as well', async () => {
    const f = await fixture(); f.plugin.accessToken = Promise.resolve('old-access'); let events = 0;
    f.setPost(async url => url.endsWith('/token') ? tokenResponse() : (++events === 1 ? Promise.reject(httpError(401)) : {status:202}));
    await f.plugin.postEvent(discoveryEvent());
    assert.equal(f.posts.at(-1)[1].event.payload.scope.token, 'fresh-access');
});
test('a second 401 is surfaced without a refresh loop or deleting refresh credentials', async () => {
    const f = await fixture(); f.plugin.accessToken = Promise.resolve('old');
    f.setPost(async url => url.endsWith('/token') ? tokenResponse() : Promise.reject(httpError(401)));
    await assert.rejects(f.plugin.postEvent(endpointEvent()), /HTTP 401/);
    assert.equal(f.posts.filter(([url]) => url.endsWith('/token')).length, 1);
    assert.equal(f.values.tokenInfo.refresh_token, 'refresh-a');
});
test('only a confirmed disabled skill clears credentials on 403', async () => {
    for (const code of ['SKILL_DISABLED_EXCEPTION','SKILL_NEVER_ENABLED_EXCEPTION','INSUFFICIENT_PERMISSION_EXCEPTION',undefined]) {
        const f = await fixture(); f.plugin.accessToken = Promise.resolve('access');
        f.setPost(async () => { throw httpError(403,code); });
        await assert.rejects(f.plugin.postEvent(endpointEvent()), /HTTP 403/);
        assert.equal(f.values.tokenInfo === undefined, code === 'SKILL_DISABLED_EXCEPTION');
    }
});
test('transient gateway failures retry three times, then propagate', async () => {
    for (const status of [429,500,503,undefined]) {
        const f = await fixture(); f.plugin.accessToken = Promise.resolve('access');
        f.setPost(async () => { throw status ? httpError(status) : new Error('network down'); });
        await assert.rejects(f.plugin.postEvent(endpointEvent()), /delivery failed/);
        assert.equal(f.posts.length, 4); assert.deepEqual(f.delays, [1000,2000,4000]);
    }
});
test('malformed event failures are not retried', async () => {
    const f = await fixture(); f.plugin.accessToken = Promise.resolve('access');
    f.setPost(async () => { throw httpError(400); });
    await assert.rejects(f.plugin.postEvent(endpointEvent()), /HTTP 400/);
    assert.equal(f.posts.length, 1);
});
test('a delayed 401 reuses a refresh already started by another event', async () => {
    const first = deferred(); const f = await fixture(); f.plugin.accessToken = Promise.resolve('old');
    let calls = 0; f.setPost(async () => ++calls === 1 ? first.promise : {status:202});
    const pending = f.plugin.postEvent(endpointEvent());
    while (!f.posts.length) await Promise.resolve();
    f.plugin.accessToken = Promise.resolve('concurrently-refreshed'); first.reject(httpError(401));
    await pending;
    assert.equal(f.posts.length, 2); assert.equal(f.posts[1][2].headers.Authorization, 'Bearer concurrently-refreshed');
});
test('token configuration and network errors preserve credentials without exposing secrets', async () => {
    for (const error of ['invalid_client','unauthorized_client',undefined]) {
        const f = await fixture({post:async()=>{throw {response:{status:400,data:{error}},config:{data:'client_secret=runtime-test-secret'}};}});
        await assert.rejects(f.plugin.getAccessToken(), e => !JSON.stringify(e).includes('runtime-test-secret'));
        assert.equal(f.values.tokenInfo.refresh_token, 'refresh-a');
    }
});
test('invalid_grant clears unusable credentials', async () => {
    const f = await fixture({post:async()=>{throw {response:{status:400,data:{error:'invalid_grant'}}};}});
    await assert.rejects(f.plugin.getAccessToken(), /token exchange failed/);
    assert.equal(f.values.tokenInfo, undefined);
});
test('an old failed exchange cannot erase newer credentials or its cached promise', async () => {
    const old = deferred(); const f = await fixture({post:()=>old.promise});
    const pending = f.plugin.getAccessToken();
    await f.plugin.putSetting('pairedUserId','account-b');
    f.values.tokenInfo = {refresh_token:'refresh-b'};
    const newer = Promise.resolve('access-b'); f.plugin.accessToken = newer;
    old.reject({response:{status:400,data:{error:'invalid_grant'}}});
    await assert.rejects(pending);
    assert.equal(f.values.tokenInfo.refresh_token,'refresh-b'); assert.equal(f.plugin.accessToken,newer);
});
test('an old successful exchange cannot restore credentials after pairing changes', async () => {
    const old = deferred(); const f = await fixture({post:()=>old.promise});
    const pending = f.plugin.getAccessToken(); await f.plugin.putSetting('pairedUserId','account-b');
    old.resolve(tokenResponse('old-access')); await assert.rejects(pending, /authorization changed/);
    assert.equal(f.values.tokenInfo,undefined);
});
test('removing the last endpoint sends a DeleteReport and clears acknowledged state', async () => {
    const f = await fixture({values:{syncedDevices:['last']}}); f.plugin.getEndpoints = async () => [];
    await f.plugin.syncEndpoints();
    const events = f.posts.filter(([url])=>url.endsWith('/events'));
    assert.equal(events.length,1); assert.equal(events[0][1].event.header.name,'DeleteReport');
    assert.deepEqual(plain(events[0][1].event.payload.endpoints),[{endpointId:'last'}]);
    assert.deepEqual(plain(f.values.syncedDevices),[]);
});
test('failed deletion remains pending and the next reconciliation can recover', async () => {
    const f = await fixture({values:{syncedDevices:['deleted','retained']}});
    f.plugin.getEndpoints = async () => [{endpointId:'retained'}];
    f.setPost(async (url,data) => {
        if (url.endsWith('/token')) return tokenResponse();
        if (data.event.header.name === 'DeleteReport') throw httpError(503);
        return {status:202};
    });
    await assert.rejects(f.plugin.syncEndpoints());
    assert.deepEqual(plain(f.values.syncedDevices),['deleted','retained']);
    f.setPost(async()=>({status:202})); await f.plugin.syncEndpoints();
    assert.deepEqual(plain(f.values.syncedDevices),['retained']);
});
test('failed additions do not claim success or prune old state', async () => {
    const f = await fixture({values:{syncedDevices:['old']}}); f.plugin.accessToken = Promise.resolve('access');
    f.plugin.getEndpoints = async () => [{endpointId:'new'}]; f.setPost(async()=>{throw httpError(400);});
    await assert.rejects(f.plugin.syncEndpoints()); assert.deepEqual(f.values.syncedDevices,['old']);
});
test('overlapping reconciliations read and update state serially', async () => {
    const first = deferred(); const f = await fixture(); let reads = 0;
    f.plugin.getEndpoints = async () => ++reads === 1 ? first.promise : [];
    const a = f.plugin.syncEndpoints(), b = f.plugin.syncEndpoints();
    await Promise.resolve(); assert.equal(reads,1);
    first.resolve([{endpointId:'new'}]); await Promise.all([a,b]);
    const names=f.posts.filter(([url])=>url.endsWith('/events')).map(([,data])=>data.event.header.name);
    assert.deepEqual(names,['AddOrUpdateReport','DeleteReport']);
    assert.deepEqual(plain(f.values.syncedDevices),[]);
});
test('empty initial state does not require linking or send an empty discovery event', async () => {
    const f = await fixture({values:{tokenInfo:undefined}});
    f.plugin.getEndpoints=async()=>[]; await f.plugin.syncEndpoints(); assert.equal(f.posts.length,0);
});
test('removing a deleted Scrypted device still reconciles endpoints', async () => {
    const f = await fixture({values:{syncedDevices:['removed']}}); f.plugin.getEndpoints=async()=>[];
    await f.plugin.releaseMixin('removed'); assert.deepEqual(plain(f.values.syncedDevices),[]);
});
test('pending deletions do not keep publishing opted-out device events', async () => {
    const f = await fixture({values:{syncedDevices:['removed']}}); let reports=0;
    f.supportedTypes.set('Switch',{sendEvent:async()=>{reports++;return {};}});
    await f.plugin.deviceListen({id:'removed',type:'Switch',mixins:[]},{eventInterface:'OnOff'},true);
    assert.equal(reports,0);
});
test('debug logging redacts tokens and authorization codes', async () => {
    const f = await fixture({values:{debug:true}});
    await f.plugin.onRequest({headers:{authorization:'private-bearer'},body:JSON.stringify({directive:{header:{namespace:'Unknown',name:'Unknown'},endpoint:{endpointId:'switch',scope:{token:'private-scope'}},payload:{code:'private-code',client_secret:'private-secret'}}})},{send:()=>{}});
    const logs=JSON.stringify(f.logs);
    for (const secret of ['private-bearer','private-scope','private-code','private-secret']) assert.ok(!logs.includes(secret));
    assert.ok(logs.includes('[REDACTED]'));
});
