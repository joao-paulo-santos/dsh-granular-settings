/**
 * dsh-granular-settings — host half.
 *
 * Per-workspace and per-session settings that OTHER plugins contribute
 * controls to. Designed for a SHARED ECOSYSTEM: every registration is
 * namespaced by the owning plugin's PACKAGE NAME, so third-party plugins can
 * never collide on key names — 'enabled' from dsh-foo and 'enabled' from
 * dsh-bar are different settings in different namespaces.
 *
 * Contributor API (host bundles):
 *
 *   const gs = ctx.get('granularSettings')          // hard dep: inject it
 *   const s = gs.register({
 *     namespace: 'my-plugin',          // REQUIRED: package name, [a-z][a-z0-9-]*
 *                                      // stable identity — NOT the display owner
 *     scope: 'session' | 'workspace',
 *     key: 'my-toggle',                // [a-z][a-z0-9-]* — unique ONLY within
 *                                      // the namespace, so generic keys are fine
 *     type: 'toggle' | 'text' | 'color',
 *     label: 'My Feature',
 *     owner: 'My Plugin',              // display name for the Settings tab box
 *     description: 'What it does',     // optional
 *     defaultValue: true,
 *     onChange: (value, target) => {}, // optional, serialized after persist
 *   })
 *   await s.get(sessionIdOrWorkspacePath)
 *   await s.set(sessionIdOrWorkspacePath, value)
 *   s.dispose()
 *
 * Storage (per workspace, namespaced per plugin):
 *   <workspace>/.dsh/settings/workspace.json
 *     { "my-plugin": { "my-toggle": true }, "_revision": n }
 *   <workspace>/.dsh/settings/sessions/<sessionId>.json
 *     { "my-plugin": { "my-toggle": false }, "_revision": n }
 * NO MIGRATIONS while pre-1.0 (project policy): store-shape changes delete
 * stale test data in a one-time manual reset instead of carrying legacy
 * conversion code. Reads are defensive (a non-conforming file reads as
 * empty; the next write replaces it in the current shape).
 *
 * Push: DOORBELLS only — 'granular-settings/<namespace>/change' with a NULL
 * payload. No values on the wire, one uniform behavior for every consumer;
 * each plugin hears only its own namespace's changes. The set route's HTTP
 * response echoes the value to the caller (point-to-point, not a broadcast).
 *
 * Routes:
 *   GET  /granular-settings/describe?session=<sid>
 *   POST /granular-settings/set { namespace, scope, key, value, sessionId }
 */

export const name = 'granular-settings'

export const inject = ['fs', 'sessions', 'webServer']

const KEY_PATTERN = /^[a-z][a-z0-9-]*$/
const NS_PATTERN = /^[a-z][a-z0-9-]*$/

// Global-scope storage: one install-wide store under $DSH_HOME (same HOME
// resolution as dsh-notifications). Global values are plugin-wide — unrelated
// to any workspace or session.
const HOME = process.env.DSH_HOME && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : homedir() + '/.dsh'
const GLOBAL_DIR = HOME + '/settings/plugins'
// Centralized session/workspace storage (layout toggle OFF): one directory
// per workspace under $DSH_HOME, mirroring the in-workspace layout.
const CENTRAL_WS_DIR = HOME + '/settings/workspaces'
// Option D: ONE FILE PER PLUGIN — isolation, self-evident ownership, and a
// per-plugin reset is "delete your file". Serving is zero-read (see the
// boot-hydrated global cache below), so the per-plugin layout costs nothing
// at request time.
const globalFileOf = (namespace) => GLOBAL_DIR + '/' + namespace + '.json'
import { homedir } from 'node:os'

const msg = (error) => (error && error.message ? error.message : String(error))

const settingsDirOf = (workspacePath) => {
  const base = (workspacePath.length > 1 && workspacePath.endsWith('/'))
    ? workspacePath.slice(0, -1)
    : workspacePath
  return base + '/.dsh/settings'
}
const fileOf = (dir, scope, sessionId) => scope === 'session'
  ? dir + '/sessions/' + sessionId + '.json'
  : dir + '/workspace.json'

export function apply(ctx) {
  const fs = ctx.fs
  const sessions = ctx.sessions
  const webServer = ctx.webServer

  let tail = Promise.resolve()

  // ---- registrations: '<namespace>:<scope>:<key>' -> registration ----
  const registrations = new Map()

  const validateRegistration = (input) => {
    const where = 'granularSettings.register: '
    if (input === null || typeof input !== 'object') throw new Error(where + 'registration object required')
    if (typeof input.namespace !== 'string' || NS_PATTERN.test(input.namespace) !== true) {
      throw new Error(where + 'namespace must be the owning package name, matching [a-z][a-z0-9-]*')
    }
    if (input.scope !== 'workspace' && input.scope !== 'session' && input.scope !== 'global') {
      throw new Error(where + 'scope must be "workspace", "session", or "global"')
    }
    if (typeof input.key !== 'string' || KEY_PATTERN.test(input.key) !== true) {
      throw new Error(where + 'key must match [a-z][a-z0-9-]*')
    }
    const TYPES = ['toggle', 'text', 'color', 'number', 'slider', 'enum', 'multiselect', 'keybind', 'path']
    if (TYPES.indexOf(input.type) === -1) {
      throw new Error(where + 'type must be one of: ' + TYPES.join(', '))
    }
    // ---- type-specific registration metadata ----
    let min, max, step, options, optionsProvider
    if (input.type === 'number') {
      if (input.min !== undefined && (typeof input.min !== 'number' || !Number.isFinite(input.min))) throw new Error(where + 'min must be a finite number')
      if (input.max !== undefined && (typeof input.max !== 'number' || !Number.isFinite(input.max))) throw new Error(where + 'max must be a finite number')
      if (input.min !== undefined && input.max !== undefined && input.min > input.max) throw new Error(where + 'min must be <= max')
      min = input.min; max = input.max
    }
    if (input.type === 'slider') {
      if (typeof input.min !== 'number' || typeof input.max !== 'number' || typeof input.step !== 'number'
        || !Number.isFinite(input.min) || !Number.isFinite(input.max) || !Number.isFinite(input.step)) {
        throw new Error(where + 'slider requires finite number min, max, and step')
      }
      if (input.min > input.max) throw new Error(where + 'min must be <= max')
      if (input.step <= 0) throw new Error(where + 'step must be > 0')
      min = input.min; max = input.max; step = input.step
    }
    if (input.type === 'enum' || input.type === 'multiselect') {
      // Static list (validated now) or a DYNAMIC PROVIDER: a zero-arg
      // function evaluated at describe time, so an option list can track a
      // live library (e.g. personas) without re-registration churn. The
      // provider's OUTPUT is validated on every evaluation.
      if (typeof input.options === 'function') {
        optionsProvider = input.options
      } else {
        options = cleanOptions(input.options)
      }
    }
    if (typeof input.label !== 'string' || input.label.trim() === '') throw new Error(where + 'label string required')
    // Display name for the Settings tab's per-plugin box (grouping only —
    // never an identity; identities are the namespace).
    const owner = typeof input.owner === 'string' && input.owner.trim() !== ''
      ? input.owner.trim().slice(0, 60)
      : input.namespace
    const defaultValue = input.type === 'toggle'
      ? (typeof input.defaultValue === 'boolean' ? input.defaultValue : false)
      : input.type === 'color'
        ? (typeof input.defaultValue === 'string' && input.defaultValue.length <= 64
          ? input.defaultValue
          : '#3b82f6')
        : (input.type === 'number' || input.type === 'slider')
          ? (typeof input.defaultValue === 'number' && Number.isFinite(input.defaultValue) ? input.defaultValue : (min !== undefined ? min : 0))
          : input.type === 'enum'
            ? (options !== undefined
              ? (options.some((o) => o.value === input.defaultValue) ? input.defaultValue : options[0].value)
              : (typeof input.defaultValue === 'string' && input.defaultValue !== '' ? input.defaultValue : undefined))
            : input.type === 'multiselect'
              ? (Array.isArray(input.defaultValue)
                ? input.defaultValue.filter((v) => typeof v === 'string' && options.some((o) => o.value === v))
                : [])
              : (typeof input.defaultValue === 'string' ? input.defaultValue : '')
    return {
      namespace: input.namespace,
      scope: input.scope,
      key: input.key,
      type: input.type,
      label: input.label.slice(0, 120),
      owner: owner,
      ...(min !== undefined ? { min: min } : {}),
      ...(max !== undefined ? { max: max } : {}),
      ...(step !== undefined ? { step: step } : {}),
      ...(options !== undefined ? { options: options } : {}),
      ...(optionsProvider !== undefined ? { optionsProvider: optionsProvider } : {}),
      ...(typeof input.description === 'string' && input.description !== ''
        ? { description: input.description.slice(0, 400) } : {}),
      defaultValue: defaultValue,
      ...(typeof input.onChange === 'function' ? { onChange: input.onChange } : {}),
    }
  }

  const cleanOptions = (opts) => {
    if (!Array.isArray(opts) || opts.length === 0) throw new Error('granularSettings: ' + 'options must be a non-empty array of {value,label}')
    const seen = new Set()
    const out = []
    for (const o of opts) {
      if (o === null || typeof o !== 'object' || typeof o.value !== 'string' || o.value === '') {
        throw new Error('granularSettings: ' + 'each option needs a non-empty string value')
      }
      if (seen.has(o.value)) throw new Error('granularSettings: ' + 'duplicate option value "' + o.value + '"')
      seen.add(o.value)
      out.push({ value: o.value, label: typeof o.label === 'string' && o.label !== '' ? o.label : o.value })
    }
    return out
  }

  // Resolve a registration's CURRENT option list: the static list, or the
  // provider's fresh output (validated on every call — a provider that goes
  // bad fails loud at the read, not silently). Returns undefined for
  // non-option types.
  const currentOptionsOf = (reg) => {
    if (reg.optionsProvider !== undefined) return cleanOptions(reg.optionsProvider())
    return reg.options
  }

  // ---- value storage (namespaced per plugin, revision-tracked) ----
  // Store shape (v2): { "<namespace>": { "<key>": value }, "_revision": n }.
  // NO MIGRATIONS while pre-1.0 (project policy): a shape change means
  // deleting stale test data — one-time, manual, zero legacy code carried.
  const readStore = async (path) => {
    try {
      const raw = await fs.readText(await fs.resolve(path))
      const parsed = raw === '' ? {} : JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { values: {}, revision: 0 }
      const { _revision, ...values } = parsed
      // Defensive read: only object-valued top-level entries are namespaces.
      // (A legacy flat or corrupt file simply reads as empty; the next write
      // overwrites it in the current shape.)
      const clean = {}
      let conforming = false
      for (const [ns, v] of Object.entries(values)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) { clean[ns] = v; conforming = true }
      }
      return {
        values: clean,
        // A file with NO conforming namespaces is stale/legacy: treat as
        // brand-new (revision 0) — under the no-migration policy the next
        // write replaces it wholesale with a fresh revision.
        revision: conforming && typeof _revision === 'number' && Number.isFinite(_revision) ? _revision : 0,
      }
    } catch (e) { return { values: {}, revision: 0 } }
  }
  const writeStore = (path, dir, values, revision) => {
    tail = tail.then(async () => {
      const body = JSON.stringify({ ...values, _revision: revision }, null, 2) + '\n'
      await fs.writeText(await fs.resolve(path), body, undefined, undefined,
        { mode: 'workspace-write', workspaceRoot: dir })
    })
    return tail
  }

  // ---- global cache (option D): files are truth across restarts, memory
  // serves requests. Hydrated ONCE at boot by scanning GLOBAL_DIR (every
  // *.json file = one plugin's values, keyed by filename); writes update
  // memory first (write-through) and persist their one plugin's file.
  // describe/get for global scope NEVER touches the disk after boot.
  const globalCache = new Map()      // namespace -> { values: {key: v}, revision: n }
  const hydrateGlobal = async () => {
    try {
      const dir = await fs.resolve(GLOBAL_DIR)
      const entries = await fs.listDir(dir)
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        const name = entry.name
        if (typeof name !== 'string' || !name.endsWith('.json')) continue
        if (entry.type !== undefined && entry.type !== 'file') continue
        const ns = name.slice(0, -5)
        if (ns === '' || !NS_PATTERN.test(ns)) continue
        // A per-plugin global file is FLAT: { "<key>": value, "_revision": n }
        // — the namespace is the filename. (readStore's defensive filter
        // expects the nested multi-namespace shape and would empty it.)
        try {
          const raw = await fs.readText(await fs.resolve(GLOBAL_DIR + '/' + name))
          const parsed = raw === '' ? {} : JSON.parse(raw)
          if (parsed === null || typeof parsed === 'object' && !Array.isArray(parsed)) {
            const { _revision, ...values } = parsed ?? {}
            const clean = {}
            for (const [k, v] of Object.entries(values)) {
              if (v === null || typeof v === 'object') continue   // keys hold scalars only
              clean[k] = v
            }
            globalCache.set(ns, { values: clean, revision: typeof _revision === 'number' ? _revision : 0 })
          }
        } catch (e) { /* one unreadable file reads as empty; neighbors unaffected */ }
      }
    } catch (e) {
      // Absent directory (fresh install) hydrates empty; the first global
      // write creates it (writeText auto-creates parents).
    }
  }
  tail = tail.then(() => hydrateGlobal())

  const globalStoreOf = (namespace) => {
    let entry = globalCache.get(namespace)
    if (entry === undefined) {
      entry = { values: {}, revision: 0 }
      globalCache.set(namespace, entry)
    }
    return entry
  }
  const persistGlobal = (namespace, entry) => {
    tail = tail.then(async () => {
      // FLAT shape: this file is one namespace (identity = filename).
      const body = JSON.stringify({ ...entry.values, _revision: entry.revision }, null, 2) + '\n'
      await fs.writeText(await fs.resolve(globalFileOf(namespace)), body, undefined, undefined,
        { mode: 'workspace-write', workspaceRoot: GLOBAL_DIR })
    })
    return tail
  }

  // resolve a target's storage: scope+target -> {path, dir}
  const storeOf = (scope, target, namespace) => {
    if (scope === 'global') {
      // Global scope: per-plugin file, plugin-wide values unrelated to any
      // workspace/session. Target is ignored — the namespace IS the target.
      if (typeof namespace !== 'string' || namespace === '') throw new Error('global scope requires a namespace')
      return { path: globalFileOf(namespace), dir: GLOBAL_DIR }
    }
    const wsRoot = (cwd) => layoutInWorkspace ? settingsDirOf(cwd) : centralDirOf(cwd)
    if (scope === 'session') {
      if (typeof target !== 'string' || target === '') throw new Error('session scope target requires a sessionId')
      const session = sessions.get(target)
      const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : undefined
      if (cwd === undefined) throw new Error('session has no resolvable workspace')
      const dir = wsRoot(cwd) + '/sessions'
      return { path: dir + '/' + target + '.json', dir: dir }
    }
    if (typeof target !== 'string' || target === '') throw new Error('workspace scope target requires a workspace path')
    const dir = wsRoot(target)
    return { path: fileOf(dir, 'workspace'), dir: dir }
  }

  // ---- storage layout: workspace-scoped vs centralized ----
  // When ON (default), session/workspace values live inside their workspace
  // (<ws>/.dsh/settings/...) and travel with it. When OFF, they are stored
  // CENTRALLY under ~/.dsh/settings/workspaces/<slug>/... — the workspace
  // tree stays clean; values follow the install instead of the folder.
  let layoutInWorkspace = true
  const wsSlugOf = (workspacePath) => {
    const trimmed = workspacePath.replace(/\/+$/, '')
    const raw = trimmed.split('/').filter((p) => p !== '').join('-')
    const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    return slug === '' ? 'root' : (slug.length > 80 ? slug.slice(0, 80) : slug)
  }
  const centralDirOf = (workspacePath) => CENTRAL_WS_DIR + '/' + wsSlugOf(workspacePath)

  // ---- the service ----
  const api = {
    register(input) {
      const reg = validateRegistration(input)
      const id = reg.namespace + ':' + reg.scope + ':' + reg.key
      if (registrations.has(id)) {
        throw new Error('granular setting "' + id + '" is already registered')
      }
      registrations.set(id, reg)
    // REGISTRATION IS A DOORBELL TOO (boot-race fix): consumers that
    // fetched describe before this registration landed (browser opens
    // while host plugins still load) get told their truth is stale. Same
    // topic, same null payload — "refetch", nothing more.
    try {
      const relay = ctx.get('eventRelay')
      if (relay !== undefined) relay.publish('granular-settings/' + input.namespace + '/change', null)
    } catch (e) { /* push degrades to pull */ }
      const handle = { get: undefined, set: undefined, dispose: undefined }
      handle.get = async (target) => {
        if (reg.scope === 'global') {
          const entry = globalStoreOf(reg.namespace)
          const v = entry.values[reg.key]
          if (reg.type === 'toggle') return v === undefined ? reg.defaultValue === true : v === true
          if (reg.type === 'number' || reg.type === 'slider') return typeof v === 'number' && Number.isFinite(v) ? v : reg.defaultValue
          if (reg.type === 'multiselect') return Array.isArray(v) ? v : reg.defaultValue
          return typeof v === 'string' ? v : reg.defaultValue
        }
        const store = storeOf(reg.scope, target, reg.namespace)
        const { values } = await readStore(store.path)
        const ns = values[reg.namespace]
        const v = ns !== undefined && ns !== null && typeof ns === 'object' ? ns[reg.key] : undefined
        if (reg.type === 'toggle') return v === undefined ? reg.defaultValue === true : v === true
        if (reg.type === 'number' || reg.type === 'slider') return typeof v === 'number' && Number.isFinite(v) ? v : reg.defaultValue
        if (reg.type === 'multiselect') return Array.isArray(v) ? v : reg.defaultValue
        if (reg.type === 'enum') {
          // Dynamic options: a stored/default value can vanish from the
          // list (library edited). Fall back to the first CURRENT option
          // rather than returning a value the UI cannot render.
          if (typeof v === 'string' && v !== '') {
            const opts = currentOptionsOf(reg)
            if (opts === undefined || opts.some((o) => o.value === v)) return v
          }
          const opts = currentOptionsOf(reg)
          return opts !== undefined && opts.length > 0 ? opts[0].value : reg.defaultValue
        }
        return typeof v === 'string' ? v : reg.defaultValue
      }
      handle.set = async (target, value) => {
        await setValue(reg.namespace, reg.scope, reg.key, value, reg.scope === 'global' ? 'global' : target)
      }
      handle.dispose = () => {
        if (registrations.get(id) === reg) {
          registrations.delete(id)
          // Disposal rings too: live UIs drop the box without a refresh.
          try {
            const relay = ctx.get('eventRelay')
            if (relay !== undefined) relay.publish('granular-settings/' + reg.namespace + '/change', null)
          } catch (e) { /* push degrades to pull */ }
        }
      }
      return handle
    },
  }
  ctx.provide('granularSettings', api)

  // The platform's OWN global setting: where session/workspace values live.
  // Registered through our own service (dogfooding); default ON.
  const layout_setting = api.register({
    namespace: 'granular-settings',
    owner: 'Granular Settings',
    scope: 'global',
    key: 'store-in-workspace',
    type: 'toggle',
    label: 'Store workspace settings inside workspace',
    description: 'On: session/workspace settings live in <workspace>/.dsh/settings and travel with the folder. Off: they are stored centrally under the DSH home, keeping workspaces clean.',
    defaultValue: true,
    onChange: (value) => { layoutInWorkspace = value === true },
  })
  // Honor an already-persisted OFF at boot (onChange fires only on change).
  tail = tail.then(async () => {
    try { if (await layout_setting.get('global') === false) layoutInWorkspace = false } catch (e) {}
  })
  const tab_setting = api.register({
    namespace: 'granular-settings',
    owner: 'Granular Settings',
    scope: 'global',
    key: 'granular-tab',
    type: 'toggle',
    label: 'Granular Settings tab inside session',
    description: 'Show a Granular Settings view tab beside Chat in each session, rendering the same page as the global settings dialog entry.',
    defaultValue: true,
  })
  const disposers = [
    () => { try { layout_setting.dispose() } catch (e) {} },
    () => { try { tab_setting.dispose() } catch (e) {} },
  ]

  // ---- set + change fan-out ----
  const setValue = async (namespace, scope, key, value, target) => {
    const reg = registrations.get(namespace + ':' + scope + ':' + key)
    if (reg === undefined) throw new Error('unknown setting "' + namespace + ':' + scope + ':' + key + '"')
    if (reg.type === 'toggle' && typeof value !== 'boolean') throw new Error('toggle value must be boolean')
    if (reg.type === 'text') {
      if (typeof value !== 'string') throw new Error('text value must be a string')
      if (value.length > 4000) throw new Error('text value too long (max 4000)')
    }
    if (reg.type === 'color' || reg.type === 'keybind' || reg.type === 'path') {
      if (typeof value !== 'string') throw new Error(reg.type + ' value must be a string')
      if (value.length > 512) throw new Error(reg.type + ' value too long (max 512)')
    }
    if (reg.type === 'number' || reg.type === 'slider') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(reg.type + ' value must be a finite number')
      if (reg.min !== undefined && value < reg.min) throw new Error(reg.type + ' value must be >= ' + reg.min)
      if (reg.max !== undefined && value > reg.max) throw new Error(reg.type + ' value must be <= ' + reg.max)
    }
    const currentOptions = currentOptionsOf(reg)
    if (reg.type === 'enum') {
      if (typeof value !== 'string' || currentOptions === undefined || !currentOptions.some((o) => o.value === value)) {
        throw new Error('enum value must be one of the current options')
      }
    }
    if (reg.type === 'multiselect') {
      if (!Array.isArray(value)) throw new Error('multiselect value must be an array')
      const allowed = new Set((currentOptions !== undefined ? currentOptions : []).map((o) => o.value))
      for (const v of value) {
        if (typeof v !== 'string' || !allowed.has(v)) throw new Error('multiselect values must be registered options')
      }
    }
    if (scope === 'global') {
      // Write-through cache: memory first (serving is instant), then persist
      // THIS plugin's file only. No other plugin's file is touched.
      const entry = globalStoreOf(namespace)
      entry.values[key] = value
      entry.revision = (typeof entry.revision === 'number' ? entry.revision : 0) + 1
      await persistGlobal(namespace, entry)
    } else {
      const store = storeOf(scope, target, namespace)
      const { values, revision } = await readStore(store.path)
      if (values[namespace] === undefined || values[namespace] === null || typeof values[namespace] !== 'object') {
        values[namespace] = {}
      }
      values[namespace][key] = value
      await writeStore(store.path, store.dir, values, revision + 1)
    }

    const info = { namespace: namespace, scope: scope, key: key, target: target, value: value }
    ctx.emit('granular-settings/change', info)
    // DOORBELL-ONLY push, uniformly: 'granular-settings/<namespace>/change'
    // with a NULL payload — no data on the wire, each plugin hears only its
    // own namespace, consumers fetch their own truth. The set route's HTTP
    // response echoes the value to the caller (point-to-point, not broadcast).
    const relay = ctx.get('eventRelay')
    if (relay !== undefined) {
      try { relay.publish('granular-settings/' + namespace + '/change', null) } catch (e) {}
    }
    if (typeof reg.onChange === 'function') {
      tail = tail.then(async () => {
        try { reg.onChange(value, target) }
        catch (error) { console.error('granular-settings: onChange for "' + key + '" failed: ' + msg(error)) }
      })
    }
    return value
  }

  // ---- routes ----
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })

  const contextOfSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return { error: 'sessionId required' }
    const session = sessions.get(sessionId)
    if (session === undefined || session === null) return { error: 'unknown session' }
    const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : undefined
    if (cwd === undefined) return { error: 'session has no resolvable workspace' }
    // Layout-aware: dir follows the ACTIVE storage layout (storeOf routes
    // writes through the same rule, so reads and writes can never diverge).
    return { sessionId: sessionId, workspace: cwd, dir: layoutInWorkspace ? settingsDirOf(cwd) : centralDirOf(cwd) }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/granular-settings/describe',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const sessionParam = url.searchParams.get('session')
        // Sessionless describe (settings dialog with nothing open): global
        // registrations and values only; session/workspace fields are absent.
        const info = sessionParam === null || sessionParam === ''
          ? undefined
          : contextOfSession(sessionParam)
        if (info !== undefined && info.error !== undefined) return sendJson(res, 404, { error: info.error })
        // Globals serve from the boot-hydrated cache: ZERO disk reads per
        // describe regardless of plugin count (option D).
        const globalValues = {}
        let globalRevision = 0
        for (const [ns, entry] of globalCache) {
          if (entry.values === undefined || Object.keys(entry.values).length === 0) continue
          globalValues[ns] = entry.values
          globalRevision += typeof entry.revision === 'number' ? entry.revision : 0
        }
        const wsStore = info === undefined
          ? { values: {}, revision: 0 }
          : await readStore(fileOf(info.dir, 'workspace'))
        const sStore = info === undefined
          ? { values: {}, revision: 0 }
          : await readStore(info.dir + '/sessions/' + info.sessionId + '.json')
        const registrationsOut = [...registrations.values()].map((r) => ({
          namespace: r.namespace,
          scope: r.scope, key: r.key, type: r.type, label: r.label, owner: r.owner,
          ...(r.description !== undefined ? { description: r.description } : {}),
          ...(r.min !== undefined ? { min: r.min } : {}),
          ...(r.max !== undefined ? { max: r.max } : {}),
          ...(r.step !== undefined ? { step: r.step } : {}),
          ...(r.options !== undefined ? { options: r.options } : {}),
          ...(r.optionsProvider !== undefined ? { options: currentOptionsOf(r) } : {}),
          defaultValue: r.defaultValue,
        }))
        sendJson(res, 200, {
          ...(info === undefined ? {} : { sessionId: info.sessionId, workspace: info.workspace }),
          registrations: registrationsOut,
          globalValues: globalValues,
          globalRevision: globalRevision,
          workspaceValues: wsStore.values,
          workspaceRevision: wsStore.revision,
          sessionValues: sStore.values,
          sessionRevision: sStore.revision,
        })
      } catch (error) { sendJson(res, 500, { error: msg(error) }) }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/granular-settings/set',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' })
        const body = JSON.parse(await readBody(req))
        if (body === null || typeof body !== 'object') return sendJson(res, 400, { error: 'object body required' })
        const scope = body.scope === 'session' ? 'session' : (body.scope === 'workspace' ? 'workspace' : (body.scope === 'global' ? 'global' : undefined))
        if (scope === undefined) return sendJson(res, 400, { error: 'scope must be "workspace", "session", or "global"' })
        if (typeof body.namespace !== 'string' || NS_PATTERN.test(body.namespace) !== true) {
          return sendJson(res, 400, { error: 'namespace must match [a-z][a-z0-9-]*' })
        }
        if (typeof body.key !== 'string') return sendJson(res, 400, { error: 'key string required' })
        // Global scope needs no session (the namespace is the target);
        // session/workspace resolve their target through the session.
        const needsSession = scope !== 'global'
        const info = needsSession
          ? contextOfSession(typeof body.sessionId === 'string' ? body.sessionId : '')
          : undefined
        if (info !== undefined && info.error !== undefined) return sendJson(res, 404, { error: info.error })
        const target = scope === 'global' ? 'global' : (scope === 'session' ? info.sessionId : info.workspace)
        const value = await setValue(body.namespace, scope, body.key, body.value, target)
        sendJson(res, 200, { ok: true, value: value })
      } catch (error) { sendJson(res, 400, { error: msg(error) }) }
    },
  }))

  return () => { for (const d of disposers) { try { d() } catch (e) {} } }
}
