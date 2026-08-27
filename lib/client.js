/**
 * dsh-granular-settings — browser half (hand-authored client bundle).
 *
 * TWO surfaces:
 *
 *   1. The client service 'granularSettings' (injected by consumer bundles):
 *      useSetting(ns, scope, key) -> [value, setValue, loaded, busy] reactive
 *      state with default fallback, per-context snapshots, and optimistic
 *      writes; registerTab({id,label,order}, Component) to contribute whole tabs.
 *      The platform owns the session context (a hidden shell.overlay
 *      tracker), describe caching, doorbell push, and retries.
 *
 *   2. A "Granular Settings" page inside the global settings dialog
 *      (settings.section seat, additive list) with three internal tabs,
 *      rendering every registered control:
 *
 *   Workspace             — settings registered with scope 'workspace'
 *   Session               — settings registered with scope 'session'
 *   Plugin                — settings registered with scope 'global'
 *
 * The page renders with NO session open (Plugin tab): the sessionless
 * describe returns global values and all registrations.
 *
 * REACT RULE ENFORCED HERE (08-debugging Case 16): every component with hooks
 * is rendered via React.createElement — NEVER invoked as a plain function
 * (Component({...})). A function-called component's hooks attach to the
 * CALLING component's instance; when the number of such calls changes
 * between renders (rows appearing after the describe fetch), React throws
 * #310 "rendered more hooks than during the previous render" and the whole
 * view crashes. Elements, always.
 *
 * Interaction rules per guide Cases 13/14: optimistic flip + per-key
 * in-flight guard + server truth from every own-call response; the relay
 * (hard inject: activation waits for its service) carries doorbells and
 * reconnects, and window-focus refetch is the pull fallback.
 */
window.__ModuleLoader__.load({ id: 'dsh-granular-settings', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')
  // Shell primitives: same package the persona picker composes. Search box,
  // enum dropdown, multiselect chips, and row tooltips render through it so
  // every control inherits the shipped chrome and theme tokens.
  const { Input, Menu, Pill, IconChevronDownOutline14, IconSearchOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives')

  // ---- shared module store ----
  const keyListeners = new Map()   // cacheKey -> Set<fn>: every subscriber
                                    // (page skeleton AND service hooks)
  const notifyKey = (cacheKey) => {
    const set = keyListeners.get(cacheKey)
    if (set !== undefined) { for (const fn of set) { try { fn() } catch (e) {} } }
  }
  // Hooks to client services (set in apply): the path control uses the
  // runtime's native directory picker when present.
  const services = { getWorkspaces: () => undefined }
  const cache = new Map()          // cacheKey ('' sessionless | sessionId) -> describe response
  const wanted = new Map()         // cacheKey -> refcount: consumers that
                                   // ASKED for it (ensure/release). A key can
                                   // be wanted-but-uncached: a boot-time fetch
                                   // can 404 while host plugins still load —
                                   // the want survives that failure so the
                                   // next doorbell/reconnect/focus retries it.
  const inFlight = new Set()       // re-entry guards, one per write in progress
  const guardOf = (ns, scope, key, cacheKey) => ns + ':' + scope + ':' + key + ':' + cacheKey

  // ---- describe scheduling: ONE state machine per cacheKey ----
  // state: { running, dirty, notBefore, delay }
  //   running    a fetch is in flight
  //   dirty      someone asked again while we couldn't start a fetch
  //   notBefore  failure backoff: earliest allowed next start
  //   delay      current backoff (RESET_FLOOR on success, doubling to
  //              RESET_CAP on failure)
  // Every caller funnels into poke(): mid-flight requests mark dirty
  // (coalescing, no stampede), backoff-window requests mark dirty too (the
  // pending timer's fire picks them up), everything else fetches now. The
  // settle path is shared: success writes the cache and re-runs if dirty;
  // failure doubles the backoff and arms one timer while the key stays
  // wanted and uncached (restored sessions that 404 while the host still
  // loads them, transient blips). There is no second mechanism to race.
  const RESET_FLOOR_MS = 250
  const RESET_CAP_MS = 5000
  const describing = new Map()    // cacheKey -> state
  const stateOf = (cacheKey) => {
    let st = describing.get(cacheKey)
    if (st === undefined) {
      st = { running: false, dirty: false, notBefore: 0, delay: RESET_FLOOR_MS }
      describing.set(cacheKey, st)
    }
    return st
  }
  const poke = (cacheKey) => {
    const st = stateOf(cacheKey)
    if (st.running || Date.now() < st.notBefore) { st.dirty = true; return }
    st.running = true
    st.dirty = false
    const url = cacheKey === ''
      ? '/granular-settings/describe'
      : '/granular-settings/describe?session=' + encodeURIComponent(cacheKey)
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (body) => settle(cacheKey, body !== null && typeof body === 'object' ? body : null),
        () => settle(cacheKey, null),
      )
  }
  const settle = (cacheKey, body) => {
    const st = stateOf(cacheKey)
    st.running = false
    if (body !== null) {
      st.delay = RESET_FLOOR_MS
      st.notBefore = 0
      cache.set(cacheKey, body)
      lastGood.set(cacheKey, body)
      if (Array.isArray(body.registrations)) registrationsSnapshot = body.registrations
      notifyKey(cacheKey)
      if (st.dirty) { st.dirty = false; poke(cacheKey) }
      return
    }
    // Failure: back off, and retry while anyone still wants the key. The
    // CURRENT delay schedules this retry; the next one doubles (floor
    // 250ms first, then 500, 1s, ... capped).
    const use = st.delay
    st.delay = Math.min(use * 2, RESET_CAP_MS)
    st.notBefore = Date.now() + use
    if (wanted.has(cacheKey) === true && cache.has(cacheKey) !== true) {
      setTimeout(() => {
        const s = describing.get(cacheKey)
        if (s === undefined) return
        if (wanted.has(cacheKey) === true && cache.has(cacheKey) !== true && s.running !== true) {
          poke(cacheKey)
        }
      }, use)
    }
    if (st.dirty) { st.dirty = false }   // the retry IS the re-run
  }
  const describe = poke

  // Wanted-key lifecycle: refcounted so the page and N consumers share one
  // describe stream without anyone's unmount starving the others.
  const ensure = (cacheKey) => {
    wanted.set(cacheKey, (wanted.get(cacheKey) || 0) + 1)
    describe(cacheKey)
  }
  const release = (cacheKey) => {
    const n = (wanted.get(cacheKey) || 0) - 1
    if (n <= 0) wanted.delete(cacheKey)
    else wanted.set(cacheKey, n)
  }

  // Resync everything anyone cares about: cached keys AND wanted-but-
  // uncached ones (boot races, failed first fetches).
  const resync = () => { for (const k of wanted.keys()) describe(k) }

  const setValue = (cacheKey, ns, scope, key, value) => {
    const guard = guardOf(ns, scope, key, cacheKey)
    if (inFlight.has(guard)) return                    // Case 14: re-entry guard
    inFlight.add(guard)
    notifyWrites()
    const d = cache.get(cacheKey)                      // optimistic (Case 13/14)
    if (d !== undefined) {
      const values = scope === 'session' ? d.sessionValues : (scope === 'global' ? d.globalValues : d.workspaceValues)
      if (values !== undefined && values !== null && typeof values === 'object') {
        if (values[ns] === undefined || typeof values[ns] !== 'object') values[ns] = {}
        values[ns][key] = value
        notifyKey(cacheKey)
      }
    }
    fetch('/granular-settings/set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: ns, scope: scope, key: key, value: value, ...(cacheKey === '' ? {} : { sessionId: cacheKey }) }),
    }).then((r) => (r.ok ? r.json() : null)).then(() => {
      // ONE update route: the describe (here, or coalesced with the
      // doorbell's) is the only thing that rewrites the cache after a
      // write. It reconciles the optimistic flip with host truth —
      // including onChange side effects and other tabs' concurrent
      // writes — and carries real revisions.
      inFlight.delete(guard)
      notifyWrites()
      describe(cacheKey)
    }, () => { inFlight.delete(guard); notifyWrites(); describe(cacheKey) })
  }

  // The settings page's skeleton hook (registration list, workspace
  // subtitle, loading gate). Same subscription path as every service
  // consumer: one keyListeners entry, re-render on its own cacheKey only.
  const useDescribe = (cacheKey) => {
    const [, force] = React.useState(0)
    React.useEffect(() => {
      const off = subscribeKey(cacheKey, () => force((n) => n + 1))
      ensure(cacheKey)
      return () => {
        off()
        // Unmounted views drop one want: doorbells must not refetch dead
        // keys forever (refcounted — other consumers keep shared keys alive).
        release(cacheKey)
      }
    }, [cacheKey])
    return cache.get(cacheKey)
  }

  // ---- the CLIENT SERVICE (public face for other plugins' browser halves) ----
  // Consumers inject 'granularSettings' (same name as the host service; the
  // two planes never see each other) and use HOOKS. The platform owns the
  // session context, describe caching, doorbell push, boot-safe transport
  // attach, default fallback, and per-context snapshots.
  // A consumer writes
  //   const [value, setValue] = gs.useSetting('my-plugin', 'session', 'key')
  // and nothing else. One describe stream is shared by the page and every
  // consumer.

  // Subscribe to one context's updates (doorbell, reconnect, focus,
  // write completion). Returns an unsubscribe function.
  const subscribeKey = (cacheKey, cb) => {
    let set = keyListeners.get(cacheKey)
    if (set === undefined) { set = new Set(); keyListeners.set(cacheKey, set) }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) keyListeners.delete(cacheKey)
    }
  }
  // Write lifecycles (guard add/drop) re-render every mounted useSetting,
  // so busy states clear without waiting for the describe.
  const writeListeners = new Set()
  const notifyWrites = () => { for (const fn of writeListeners) { try { fn() } catch (e) {} } }

  // Registrations are context-free (every describe carries the full list):
  // snapshot them from ANY landing describe so default values resolve even
  // before a given context's own describe lands.
  let registrationsSnapshot = []
  const registrationOf = (namespace, scope, key) =>
    registrationsSnapshot.find((r) => r.namespace === namespace && r.scope === scope && r.key === key)

  // Last-known values per context, written when a describe lands. Fills
  // describe gaps: switching back to a context serves ITS last truth (never
  // another context's) while the fresh describe is in flight.
  const lastGood = new Map()      // cacheKey -> describe body

  // Resolve a setting for a context: current cache, else its last-known
  // snapshot, else the registration default, else undefined.
  const resolve = (cacheKey, namespace, scope, key) => {
    const read = (d) => {
      const values = scope === 'session'
        ? d.sessionValues : (scope === 'global' ? d.globalValues : d.workspaceValues)
      const ns = values !== null && typeof values === 'object' ? values[namespace] : undefined
      return ns !== undefined && ns !== null && typeof ns === 'object' ? ns[key] : undefined
    }
    const d = cache.get(cacheKey)
    if (d !== undefined) {
      const raw = read(d)
      if (raw !== undefined) return raw
      const reg = registrationOf(namespace, scope, key)
      return reg !== undefined ? reg.defaultValue : undefined
    }
    const g = lastGood.get(cacheKey)
    if (g !== undefined) {
      const raw = read(g)
      if (raw !== undefined) return raw
    }
    const reg = registrationOf(namespace, scope, key)
    return reg !== undefined ? reg.defaultValue : undefined
  }

  // ---- session context (module scope, fed by a hidden always-rendered slot) ----
  // useSetting needs the current session id in ANY component, not just ones
  // that receive slot props. A null-rendering shell.overlay entry captures
  // the shell's useSessions hook and mirrors the current session here.
  let currentSessionId = undefined
  const sessionListeners = new Set()
  const notifySession = () => { for (const fn of sessionListeners) { try { fn() } catch (e) {} } }
  const SessionTracker = (props) => {
    const sid = props.useSessions((st) => st.current)
    React.useEffect(() => {
      const normalized = sid === undefined || sid === null ? undefined : sid
      if (normalized !== currentSessionId) {
        currentSessionId = normalized
        notifySession()
      }
    }, [sid])
    return null
  }
  const useSessionId = () => {
    const [sid, setSid] = React.useState(currentSessionId)
    React.useEffect(() => {
      const fn = () => setSid(currentSessionId)
      sessionListeners.add(fn)
      return () => { sessionListeners.delete(fn) }
    }, [])
    return sid
  }

  // The context key a scope resolves to in this tab: global is sessionless
  // (''), session/workspace follow the open session (undefined with none:
  // values read as their defaults, writes are no-ops).
  const contextKeyOf = (scope, sid) => scope === 'global'
    ? ''
    : (sid === undefined || sid === null ? undefined : sid)

  /** Read + write one setting as reactive state.
   *  @returns [value, setValue, loaded, busy]. value falls back to the
   *  registration default while the context's truth loads. setValue is
   *  optimistic and reconciles with the host's stored value. loaded is
   *  false only for session/workspace scopes with no session open, or
   *  before the first describe lands (the default is still served).
   *  busy is true while this key's write is in flight. */
  const useSetting = (namespace, scope, key) => {
    const sid = useSessionId()
    const cacheKey = contextKeyOf(scope, sid)
    const [, force] = React.useState(0)
    React.useEffect(() => {
      if (cacheKey === undefined) return
      const off = subscribeKey(cacheKey, () => force((n) => n + 1))
      ensure(cacheKey)
      return () => { off(); release(cacheKey) }
    }, [cacheKey])
    // Writes also bump this component: the guard drop at write completion
    // must clear busy even when the describe lands later.
    React.useEffect(() => {
      const fn = () => force((n) => n + 1)
      writeListeners.add(fn)
      return () => { writeListeners.delete(fn) }
    }, [])
    const value = cacheKey === undefined ? undefined : resolve(cacheKey, namespace, scope, key)
    const write = React.useCallback((v) => {
      if (cacheKey === undefined) return
      setValue(cacheKey, namespace, scope, key, v)
    }, [cacheKey, namespace, scope, key])
    const loaded = cacheKey !== undefined && cache.has(cacheKey)
    const busy = cacheKey !== undefined
      && inFlight.has(guardOf(namespace, scope, key, cacheKey))
    return [value, write, loaded, busy]
  }

  const serviceApi = {
    useSetting,
    /** Registration metadata for one setting (type, label, description,
     *  defaultValue, min/max/step, resolved options), or undefined before
     *  any describe landed. Non-reactive by itself: read it during render
     *  after calling useSetting for the same key, whose subscription
     *  re-renders you on every describe refresh. Options arrive already
     *  resolved (providers were evaluated host-side at describe time). */
    getRegistration(namespace, scope, key) {
      const r = registrationOf(namespace, scope, key)
      if (r === undefined) return undefined
      return {
        namespace: r.namespace, scope: r.scope, key: r.key, type: r.type,
        label: r.label,
        ...(r.description !== undefined ? { description: r.description } : {}),
        defaultValue: r.defaultValue,
        ...(r.min !== undefined ? { min: r.min } : {}),
        ...(r.max !== undefined ? { max: r.max } : {}),
        ...(r.step !== undefined ? { step: r.step } : {}),
        ...(Array.isArray(r.options) ? { options: r.options } : {}),
      }
    },
    /** Contribute one whole tab to the Granular Settings page.
     *  @param options { id, label, order } — id unique (duplicate throws),
     *    order positions the tab among ours (workspace 10 / session 20 /
     *    plugin 30); @param component renders the tab body inside the page's
     *    scroll area and receives this page's section props (useSessions…).
     *  @returns an exact disposer. */
    registerTab(options, component) {
      const where = 'granularSettings.registerTab: '
      if (options === null || typeof options !== 'object') throw new Error(where + 'options object required')
      if (typeof options.id !== 'string' || options.id === '' || options.id.length > 60) {
        throw new Error(where + 'id must be a non-empty string (max 60 chars)')
      }
      if (typeof options.label !== 'string' || options.label === '' || options.label.length > 60) {
        throw new Error(where + 'label must be a non-empty string (max 60 chars)')
      }
      if (typeof options.order !== 'number' || !Number.isFinite(options.order)) {
        throw new Error(where + 'order must be a finite number')
      }
      if (typeof component !== 'function') throw new Error(where + 'component function required')
      if (tabRegistry.has(options.id)) throw new Error(where + 'tab id "' + options.id + '" is already registered')
      tabRegistry.set(options.id, { id: options.id, label: options.label, order: options.order, component: component })
      notifyAllTabs()
      return () => {
        if (tabRegistry.get(options.id) !== undefined && tabRegistry.get(options.id).component === component) {
          tabRegistry.delete(options.id)
          notifyAllTabs()
        }
      }
    },
  }

  // ---- push ----
  // The settings doorbell topic (any change under granular-settings/*) and
  // the relay's reconnect signal both mean the same thing here: cached
  // truth may be stale, refetch every wanted context. Subscribing
  // (re)opens the stream, and '__relay/open' then fires on every
  // (re)connect, healing whatever was missed while the stream was down.
  const subscribeRelay = (ctx, onStale) => {
    const relay = ctx.get('eventRelay')
    const offA = relay.subscribe('granular-settings', onStale)
    const offB = relay.subscribe('__relay', onStale)
    return () => { try { offA() } catch (e) {} try { offB() } catch (e) {} }
  }

  // ---- controls: components, rendered as ELEMENTS only ----
  const BLUE = '#3b82f6'

  const Switch = (props) => React.createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': props.value === true ? 'true' : 'false',
    className: 'gsv-switch' + (props.value === true ? ' gsv-on' : '') + (props.busy ? ' gsv-busy' : ''),
    onClick: props.onChange,
    title: props.value === true ? 'On — click to turn off' : 'Off — click to turn on',
  }, React.createElement('span', { className: 'gsv-knob' }))

  const TextField = (props) => {
    const [draft, setDraft] = React.useState(props.value)
    React.useEffect(() => { setDraft(props.value) }, [props.value])
    const commit = () => { if (draft !== props.value) props.onCommit(draft) }
    // Shell Input atom: one control chrome shared with the search box.
    return React.createElement(Input, {
      type: 'text',
      value: draft,
      disabled: props.busy,
      onChange: (e) => { setDraft(e.target.value) },
      onBlur: commit,
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } },
    })
  }

  // Color: native picker + hex readout. Invalid/absent hex falls back to blue
  // for the swatch only; the stored value passes through unchanged.
  const ColorField = (props) => {
    const hex = /^#[0-9a-fA-F]{6}$/.test(props.value) ? props.value : '#3b82f6'
    return React.createElement('div', { className: 'gsv-color' },
      React.createElement('input', {
        type: 'color',
        className: 'gsv-color-input',
        value: hex,
        disabled: props.busy,
        onChange: (e) => { props.onCommit(e.target.value) },
      }),
      React.createElement('span', { className: 'gsv-color-hex' },
        typeof props.value === 'string' ? props.value : hex))
  }

  // ---- new controls (all ELEMENTS; never function-called — Case 16) ----
  const NumberField = (props) => {
    const [draft, setDraft] = React.useState(props.value)
    React.useEffect(() => { setDraft(props.value) }, [props.value])
    const commit = () => {
      const n = typeof draft === 'number' ? draft : parseFloat(draft)
      if (Number.isFinite(n) && n !== props.value) props.onCommit(n)
      else setDraft(props.value)
    }
    return React.createElement('input', {
      type: 'number',
      className: 'gsv-input gsv-num',
      value: draft,
      ...(props.min !== undefined ? { min: props.min } : {}),
      ...(props.max !== undefined ? { max: props.max } : {}),
      ...(props.step !== undefined ? { step: props.step } : {}),
      onChange: (e) => { const v = e.target.value; setDraft(v === '' ? '' : parseFloat(v)) },
      onBlur: commit,
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } },
    })
  }

  const SliderField = (props) => {
    const [draft, setDraft] = React.useState(props.value)
    React.useEffect(() => { setDraft(props.value) }, [props.value])
    const commit = () => { if (draft !== props.value) props.onCommit(draft) }
    return React.createElement('div', { className: 'gsv-slider' },
      React.createElement('input', {
        type: 'range',
        className: 'gsv-slider-input',
        min: props.min, max: props.max, step: props.step,
        value: typeof draft === 'number' ? draft : props.min,
        onChange: (e) => { setDraft(parseFloat(e.target.value)) },
        onPointerUp: commit,
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') setTimeout(commit, 0) },
      }),
      React.createElement('span', { className: 'gsv-slider-value' },
        typeof draft === 'number' ? String(Math.round(draft * 100) / 100) : ''))
  }

  // Enum options render through the shell Menu (same primitive as the
  // composer persona picker), portal positioning so long lists escape the
  // page's scroll container.
  const EnumField = (props) => {
    const [open, setOpen] = React.useState(false)
    const options = props.options || []
    const current = options.find((o) => o.value === props.value) || options[0]
    return React.createElement(Menu, {
      open: open === true,
      side: 'top',
      portal: true,
      items: options.map((o) => ({ id: o.value, label: o.label })),
      selectedId: typeof props.value === 'string' ? props.value : undefined,
      onSelect: (id) => { setOpen(false); props.onCommit(id) },
      onClose: () => { setOpen(false) },
      anchor: React.createElement('button', {
        type: 'button',
        className: 'gsv-input gsv-select' + (props.busy ? ' gsv-busy' : ''),
        onClick: () => { setOpen(!open) },
      },
      React.createElement('span', { className: 'gsv-enum-label' }, current !== undefined ? current.label : ''),
      React.createElement(IconChevronDownOutline14)),
    })
  }

  // Multiselect options are interactive Pills (shell chip with active
  // state); tap toggles membership in the committed array.
  const MultiselectField = (props) => {
    const selected = Array.isArray(props.value) ? props.value : []
    return React.createElement('div', { className: 'gsv-chips' },
      (props.options || []).map((o) => {
        const on = selected.indexOf(o.value) !== -1
        return React.createElement(Pill, {
          key: o.value,
          active: on,
          onClick: () => {
            const next = on ? selected.filter((v) => v !== o.value) : [...selected, o.value]
            props.onCommit(next)
          },
        }, o.label)
      }))
  }

  const PathField = (props) => {
    const [busy, setBusy] = React.useState(false)
    const pick = async () => {
      const ws = services.getWorkspaces()
      if (ws === undefined || typeof ws.pickDirectory !== 'function') { setBusy(false); return }
      setBusy(true)
      try {
        const path = await ws.pickDirectory()
        if (typeof path === 'string' && path !== '') props.onCommit(path)
      } catch (e) { /* picker failure: keep current */ }
      setBusy(false)
    }
    return React.createElement('div', { className: 'gsv-path' },
      React.createElement('span', { className: 'gsv-path-value', title: typeof props.value === 'string' ? props.value : '' },
        typeof props.value === 'string' && props.value !== '' ? props.value : 'No folder selected'),
      React.createElement('button', {
        type: 'button',
        className: 'gsv-btn gsv-path-btn',
        disabled: busy,
        onClick: pick,
      }, busy ? '…' : 'Browse…'))
  }

  // A Row is the settings page's leaf, and the useSetting hook's most
  // demanding consumer: it knows only its registration and reads value,
  // busy, and the writer straight from the platform hook. The page above
  // it is pure scaffolding (grouping, tabs); no value/busy/onSet props
  // are threaded down.
  const Row = (props) => {
    const reg = props.reg
    const [value, write, , busy] = useSetting(reg.namespace, reg.scope, reg.key)
    const onSet = (v) => { write(v) }
    return React.createElement('div', { className: 'gsv-row' },
      React.createElement('div', { className: 'gsv-row-main' },
        React.createElement('div', { className: 'gsv-row-title' }, reg.label),
        reg.description !== undefined
          ? React.createElement('div', { className: 'gsv-row-desc' }, reg.description)
          : null),
      React.createElement('div', { className: 'gsv-control' },
        reg.type === 'toggle'
          ? React.createElement('div', { className: 'gsv-toggle' },
              React.createElement('span', {
                className: 'gsv-state' + (value === true ? ' gsv-state-on' : ''),
                style: value === true ? { color: BLUE } : undefined,
              }, value === true ? 'On' : 'Off'),
              React.createElement(Switch, {
                value: value === true,
                busy: busy,
                onChange: () => { onSet(value !== true) },
              }))
          : reg.type === 'color'
            ? React.createElement(ColorField, {
                value: typeof value === 'string' ? value : '',
                busy: busy,
                onCommit: onSet,
              })
            : reg.type === 'number' || reg.type === 'slider'
              ? (reg.type === 'number'
                  ? React.createElement(NumberField, {
                      value: typeof value === 'number' ? value : 0,
                      min: reg.min, max: reg.max, step: reg.step,
                      onCommit: onSet,
                    })
                  : React.createElement(SliderField, {
                      value: typeof value === 'number' ? value : (reg.min || 0),
                      min: reg.min, max: reg.max, step: reg.step,
                      onCommit: onSet,
                    }))
              : reg.type === 'enum'
                ? React.createElement(EnumField, {
                    value: typeof value === 'string' ? value : '',
                    options: reg.options,
                    busy: busy,
                    onCommit: onSet,
                  })
                : reg.type === 'multiselect'
                  ? React.createElement(MultiselectField, {
                      value: Array.isArray(value) ? value : [],
                      options: reg.options,
                      onCommit: onSet,
                    })
                  : reg.type === 'path'
                      ? React.createElement(PathField, {
                          value: typeof value === 'string' ? value : '',
                          onCommit: onSet,
                        })
                      : React.createElement(TextField, {
                          value: typeof value === 'string' ? value : '',
                          busy: busy,
                          onCommit: onSet,
                        })))
  }

  // One outer box per OWNING plugin (grouped by namespace so a renamed
  // display name can never split or merge boxes): header + its settings.
  const groupByNamespace = (regs) => {
    const groups = []
    const byNs = new Map()
    for (const r of regs) {
      const ns = typeof r.namespace === 'string' && r.namespace !== '' ? r.namespace : 'other'
      if (!byNs.has(ns)) {
        const group = { ns: ns, owner: typeof r.owner === 'string' && r.owner !== '' ? r.owner : ns, regs: [] }
        byNs.set(ns, group)
        groups.push(group)
      }
      byNs.get(ns).regs.push(r)
    }
    return groups
  }

  const PluginBox = (props) => React.createElement('div', { className: 'gsv-plugin' },
    React.createElement('div', { className: 'gsv-plugin-head' }, props.group.owner),
    React.createElement('div', { className: 'gsv-rows' },
      props.group.regs.map((reg) => React.createElement(Row, {
        key: reg.key,
        reg: reg,
      }))))

  // ---- search ----
  // Subsequence fuzzy match ("sq col" hits "Square color"): every character
  // of the needle must appear in order, case-insensitively. Cheap by
  // construction — O(haystack) per needle, no scoring, no allocations —
  // and exactly the resource budget a settings page wants.
  const fuzzyMatch = (needle, haystack) => {
    if (needle === '') return true
    let i = 0
    const h = haystack.toLowerCase()
    for (const ch of needle.toLowerCase()) {
      i = h.indexOf(ch, i)
      if (i === -1) return false
      i += 1
    }
    return true
  }
  // Does one registration match the query? Searches the label, description,
  // key, and every option label (finding "Model A" by typing its name is
  // the point of option search). The namespace/owner axis is handled by the
  // caller (a plugin-name match shows ALL of its rows).
  const regMatches = (reg, q) =>
    fuzzyMatch(q, reg.label !== undefined ? reg.label : '')
    || fuzzyMatch(q, reg.key)
    || (reg.description !== undefined && fuzzyMatch(q, reg.description))
    || (Array.isArray(reg.options) && reg.options.some((o) => fuzzyMatch(q, o.label !== undefined ? o.label : o.value)))

  const SearchBox = (props) => {
    const [draft, setDraft] = React.useState('')
    React.useEffect(() => { props.onQuery(draft) }, [draft])
    React.useEffect(() => () => { try { props.onQuery('') } catch (e) {} }, [])
    // The shell Input atom: leading magnifier, theme-handled chrome. Each
    // scope's search is its own question (keyed per section).
    return React.createElement(Input, {
      key: props.scopeKey,
      className: 'gsv-searchwrap',
      icon: React.createElement(IconSearchOutline16),
      placeholder: props.placeholder !== undefined ? props.placeholder : 'Search settings…',
      'aria-label': 'Search settings',
      value: draft,
      onChange: (e) => { setDraft(e.target.value) },
    })
  }

  const Section = (props) => {
    const [query, setQuery] = React.useState('')
    const trimmed = query.trim()
    let groups = groupByNamespace(props.regs)
    if (trimmed !== '') {
      groups = groups
        .map((group) => {
          const ownerHit = fuzzyMatch(trimmed, group.owner) || fuzzyMatch(trimmed, group.ns)
          // A plugin-name match opens the whole box; otherwise keep the
          // rows that match on their own text or options.
          const rows = ownerHit ? group.regs : group.regs.filter((reg) => regMatches(reg, trimmed))
          return { ...group, regs: rows }
        })
        .filter((group) => group.regs.length > 0)
    }
    const body = groups.length === 0
      ? React.createElement('p', { className: 'gsv-empty' },
          trimmed !== '' ? 'Nothing matches "' + trimmed + '".' : props.emptyCopy)
      : groups.map((group) => React.createElement(PluginBox, {
          key: group.ns,
          group: group,
        }))
    return React.createElement('section', { className: 'gsv-section' },
      React.createElement('h3', { className: 'gsv-h3' }, props.title),
      props.subtitle !== undefined
        ? React.createElement('p', { className: 'gsv-sub' }, props.subtitle)
        : null,
      React.createElement(SearchBox, { scopeKey: props.title, onQuery: setQuery }),
      body)
  }

  // One settings.section page with three internal tabs (Workspace / Session /
  // Plugin). The SAME Section/PluginBox/Row components render every scope;
  // only the scope filter and the describe cache key differ. The page works
  // with no session open: it then shows the Plugin tab's global values (the
  // only scope that exists without a session context).
  // Tab memory per cacheKey (session id or '' sessionless): a chosen tab
  // SURVIVES the remount a session switch causes — useState alone resets to
  // the default on every mount, so the panel "jumped to Plugin" on switch
  // (user report). Each context remembers its own last tab; the session tab
  // and the dialog share the memory for the same context. Same lesson as the
  // squares' flight physics: state that should outlive a remount cannot live
  // in the component.
  const tabMemory = new Map()
  const tabRegistryListeners = new Set()
  const notifyAllTabs = () => { for (const fn of tabRegistryListeners) { try { fn() } catch (e) {} } }
  // ---- the tab registry (the granular.tab extension point) ----
  // The page's tab strip is an extension surface: other plugins contribute
  // whole tabs through granularSettings.registerTab({id,label,order},
  // Component). Our three scope tabs are the first occupants (component
  // null = the built-in scope-section rendering); contributors render their
  // own component, receiving the section props the shell gave this page
  // (useSessions etc.). Sorted by order, id as the stable tiebreaker.
  const tabRegistry = new Map()   // id -> { id, label, order, component }
  const registerInternalTab = (id, label, order) => {
    tabRegistry.set(id, { id: id, label: label, order: order, component: null })
  }
  registerInternalTab('workspace', 'Workspace', 10)
  registerInternalTab('session', 'Session', 20)
  registerInternalTab('plugin', 'Plugin', 30)
  const sortedTabs = () => [...tabRegistry.values()].sort((a, b) =>
    a.order !== b.order ? (a.order < b.order ? -1 : 1) : (a.id < b.id ? -1 : 1))

  const GranularSettingsSection = (props) => {
    const sessionId = props.useSessions((st) => st.current)
    const cacheKey = sessionId === undefined || sessionId === null ? '' : sessionId
    const [tab, setTabState] = React.useState(tabMemory.get(cacheKey) || 'plugin')
    const setTab = (id) => { tabMemory.set(cacheKey, id); setTabState(id) }
    // cacheKey can change WITHOUT a remount (fiber reused across a switch):
    // adopt the new context's remembered tab.
    React.useEffect(() => { setTabState(tabMemory.get(cacheKey) || 'plugin') }, [cacheKey])
    const [, forceTabs] = React.useState(0)
    React.useEffect(() => {
      const listener = () => forceTabs((n) => n + 1)
      tabRegistryListeners.add(listener)
      return () => { tabRegistryListeners.delete(listener) }
    }, [])
    // Sessionless guard is scoped to OUR 'workspace' tab (its values need a
    // session context). Contributor tabs declare their own sessionless
    // eligibility by what they render.
    const effectiveTab = sessionId === undefined && tab === 'workspace' ? 'plugin' : tab
    const d = useDescribe(cacheKey)

    // The page ALWAYS opens at the top. The scrolling element is NOT
    // reliably ours: the settings dialog's own content pane is the scroller
    // (shipped sections render bare divs; our gsv-scroll's overflow only
    // activates when the dialog bounds our height), and the pane keeps its
    // scroll position between opens while the section may not even remount.
    // So: reset scrollTop on EVERY scrollable ancestor (stopping at body),
    // and re-run the reset whenever the page becomes visible again
    // (dialog reopened, in-session tab re-selected) — not just on mount,
    // tab change, context change, and load completion.
    const pageRef = React.useRef(null)
    const scrollRef = React.useRef(null)
    const resetScroll = () => {
      for (let el = scrollRef.current; el !== null && el !== undefined && el !== document.body; el = el.parentElement) {
        if (el.scrollTop > 0) el.scrollTop = 0
      }
    }
    React.useEffect(() => { resetScroll() }, [effectiveTab, cacheKey, d === undefined])
    React.useEffect(() => {
      const node = pageRef.current
      if (node === null || node === undefined || typeof IntersectionObserver !== 'function') return
      const io = new IntersectionObserver((entries) => {
        for (const en of entries) { if (en.isIntersecting) resetScroll() }
      })
      io.observe(node)
      return () => { io.disconnect() }
    }, [])

    const header = React.createElement('div', { className: 'gsv-tabs' },
      sortedTabs().map((t) => React.createElement('button', {
        key: t.id,
        type: 'button',
        className: 'gsv-tab' + (effectiveTab === t.id ? ' gsv-tab-active' : ''),
        onClick: () => { setTab(t.id) },
      }, t.label)))

    const activeEntry = tabRegistry.get(effectiveTab)
    if (activeEntry !== undefined && activeEntry.component !== null && activeEntry.component !== undefined) {
      // CONTRIBUTOR TAB: forward the section props the shell handed this
      // page — the component picks what it needs (useSessions, etc.).
      return React.createElement('div', { className: 'gsv-page', ref: pageRef }, header,
        React.createElement('div', { className: 'gsv-scroll', ref: scrollRef },
          React.createElement(activeEntry.component, props)))
    }
    if (d === undefined) {
      return React.createElement('div', { className: 'gsv-page', ref: pageRef }, header,
        React.createElement('div', { className: 'gsv-scroll', ref: scrollRef },
          React.createElement('p', { className: 'gsv-empty' }, 'Loading…')))
    }
    const regs = Array.isArray(d.registrations) ? d.registrations : []

    let body = null
    if (effectiveTab === 'plugin') {
      body = React.createElement('div', { className: 'gsv-sections' },
        React.createElement(Section, {
          title: 'Plugin settings',
          subtitle: 'Global: these values apply everywhere, in every workspace and session.',
          regs: regs.filter((r) => r.scope === 'global'),
          emptyCopy: 'No plugin settings registered yet.',
        }))
    } else if (effectiveTab === 'workspace') {
      body = React.createElement('div', { className: 'gsv-sections' },
        React.createElement(Section, {
          title: 'Workspace',
          subtitle: 'Apply to every session in ' + (typeof d.workspace === 'string' ? d.workspace : 'this workspace') + '.',
          regs: regs.filter((r) => r.scope === 'workspace'),
          emptyCopy: 'No workspace settings registered by plugins yet.',
        }))
    } else {
      // (session tab — the default)
      body = React.createElement('div', { className: 'gsv-sections' },
        React.createElement(Section, {
          title: 'This session',
          subtitle: 'Apply to the current session only.',
          regs: regs.filter((r) => r.scope === 'session'),
          emptyCopy: 'No session settings registered by plugins yet.',
        }))
    }
    return React.createElement('div', { className: 'gsv-page', ref: pageRef }, header,
      React.createElement('div', { className: 'gsv-scroll', ref: scrollRef }, body))
  }

  module.exports = {
    name: 'granular-settings-client',
    inject: ['eventRelay', 'slots'],
    apply(ctx) {
      services.getWorkspaces = () => ctx.get('workspaces')
      // Client-plane service name MATCHES the host plane's ('granularSettings'):
      // the two contexts live in different planes and can never shadow each
      // other, and consumers inject one name regardless of which half they
      // talk to (same policy as dsh-event-relay's eventRelay).
      ctx.provide('granularSettings', serviceApi)
      // Feed useSetting's session context: one hidden, always-rendered
      // shell.overlay entry that mirrors the shell's current session.
      const offTracker = ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'granular-settings-tracker', order: 999, label: 'Settings Tracker' },
        SessionTracker))
      const css = [
        '.gsv-page{flex:1 1 auto;min-height:0;height:100%;max-width:720px;width:100%;margin:0 auto;padding:24px 32px 0;box-sizing:border-box;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}',
        '.gsv-scroll{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:32px;padding-bottom:48px}',
        '.gsv-tabs{flex:none;display:flex;gap:8px;margin-bottom:20px;border-bottom:1px solid var(--dsw-alias-label-tertiary)}',
        '.gsv-tab{font:inherit;font-size:13px;padding:8px 14px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-bottom:2px solid transparent;opacity:.65;margin-bottom:-1px}',
        '.gsv-tab:hover{opacity:1}',
        '.gsv-tab-active{opacity:1;border-bottom-color:#3b82f6;font-weight:600}',
        '.gsv-sections{display:flex;flex-direction:column;gap:32px}',
        '.gsv-section{display:flex;flex-direction:column;gap:12px}',
        '.gsv-h3{margin:0;font-size:15px;font-weight:650}',
        '.gsv-sub{margin:-6px 0 0;font-size:12px;opacity:.65}',
        '.gsv-searchwrap{width:100%;box-sizing:border-box;margin-top:14px}',
        '.gsv-plugin{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-label-tertiary);border-radius:12px;overflow:hidden}',
        '.gsv-plugin-head{padding:9px 18px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-label-tertiary);font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;opacity:.8}',
        '.gsv-plugin .gsv-rows{border:none;border-radius:0}',
        '.gsv-section > .gsv-plugin + .gsv-plugin{margin-top:12px}',
        '.gsv-rows{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-label-tertiary);border-radius:12px;overflow:hidden}',
        '.gsv-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 18px;background:var(--dsw-alias-bg-layer-1)}',
        '.gsv-row + .gsv-row{border-top:1px solid var(--dsw-alias-label-tertiary)}',
        '.gsv-row-main{flex:1;min-width:0}',
        '.gsv-row-title{font-size:13px;font-weight:600}',
        '.gsv-row-desc{font-size:12px;opacity:.7;margin-top:2px}',
        '.gsv-control{display:flex;align-items:center}',
        '.gsv-toggle{display:flex;align-items:center;gap:10px}',
        '.gsv-state{font-size:11px;font-weight:700;min-width:22px;text-align:right;opacity:.45}',
        '.gsv-state-on{opacity:1}',
        '.gsv-switch{position:relative;width:38px;height:21px;min-width:38px;border-radius:999px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-label-tertiary);padding:0;transition:background .12s,border-color .12s}',
        '.gsv-switch .gsv-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-label-primary);opacity:.5;transition:left .12s,background .12s,opacity .12s}',
        '.gsv-switch.gsv-on{background:#3b82f6;border-color:#3b82f6}',
        '.gsv-switch.gsv-on .gsv-knob{left:19px;background:#fff;opacity:1}',
        '.gsv-switch.gsv-busy{opacity:.5;cursor:wait}',
        '.gsv-input{font:inherit;font-size:13px;padding:7px 11px;border-radius:8px;width:min(300px,50vw);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-label-tertiary)}',
        '.gsv-input:focus{outline:1px solid var(--dsw-alias-label-primary)}',
        '.gsv-color{display:flex;align-items:center;gap:8px}',
        '.gsv-color-input{width:44px;height:28px;padding:2px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}',
        '.gsv-color-hex{font-size:12px;opacity:.7;font-family:ui-monospace,monospace}',
        '.gsv-launch{max-width:420px;margin:64px auto;display:flex;flex-direction:column;align-items:center;gap:10px;padding:36px 28px;border:1px dashed var(--dsw-alias-label-tertiary);border-radius:14px;text-align:center}',
        '.gsv-launch-title{font-size:16px;font-weight:700}',
        '.gsv-launch-text{margin:0;font-size:13px;opacity:.7}',
        '.gsv-btn{font:inherit;font-size:13px;font-weight:600;padding:8px 18px;border-radius:10px;cursor:pointer;margin-top:8px;color:var(--dsw-alias-bg-layer-1);background:#3b82f6;border:1px solid #3b82f6}',
        '.gsv-btn:hover{opacity:.9}',
        '.gsv-num{width:110px}',
        '.gsv-slider{display:flex;align-items:center;gap:12px}',
        '.gsv-slider-input{width:200px;accent-color:#3b82f6;cursor:pointer}',
        '.gsv-slider-value{font-size:12px;opacity:.8;min-width:36px;text-align:right;font-family:ui-monospace,monospace}',
        '.gsv-select{width:auto;min-width:140px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-primary);text-align:left}',
        '.gsv-select svg{flex:none;color:var(--dsw-alias-label-caption)}',
        '.gsv-enum-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.gsv-chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;max-width:min(320px,60%)}',
        '.gsv-path{display:flex;align-items:center;gap:8px;max-width:min(340px,60%)}',
        '.gsv-path-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.75;font-family:ui-monospace,monospace}',
        '.gsv-path-btn{font-size:12px;padding:5px 10px}',
        '.gsv-empty{margin:0;padding:18px;font-size:13px;opacity:.55;border:1px dashed var(--dsw-alias-label-tertiary);border-radius:12px;text-align:center}',
      ].join('')
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-granular-settings'
      tag.textContent = css
      document.head.appendChild(tag)

      // Stale signal: relay push and focus pull converge here.
      const onFocus = () => { onStale() }
      const onStale = () => { resync(); evalTab() }
      window.addEventListener('focus', onFocus)
      const offRelay = subscribeRelay(ctx, onStale)

      const offView = ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'granular', order: 50, label: 'Granular Settings' },
        GranularSettingsSection))
      // ---- in-session Granular Settings tab (toggle-driven) ----
      // Renders THE SAME GranularSettingsSection the dialog page uses — one
      // component, two homes; users pick whichever surface they prefer.
      // Visibility follows the platform's own global toggle
      // ('granular-settings' namespace, key 'granular-tab', default on):
      // register/unregister the view entry as the value changes.
      let offTab = undefined
      let tabState = undefined
      const syncTab = (enabled) => {
        if (tabState === enabled) return
        tabState = enabled
        if (enabled === true) {
          offTab = ctx.slots.inject('conversation.view', () => ctx.slots.register(
            { name: 'conversation.view', id: 'granular-settings', order: 20, label: 'Granular Settings' },
            GranularSettingsSection))
        } else if (offTab !== undefined) {
          try { offTab() } catch (e) {}
          offTab = undefined
        }
      }
      const evalTab = () => {
        fetch('/granular-settings/describe')
          .then((r) => (r.ok ? r.json() : null)).then((d) => {
            if (d === null) { syncTab(true); return }        // fail-open: default on
            const ns = (d.globalValues !== undefined ? d.globalValues : {})['granular-settings']
            const v = ns !== undefined && ns !== null ? ns['granular-tab'] : undefined
            syncTab(v === undefined ? true : v === true)
          }, () => {})
      }
      evalTab()

      return () => {
        try { offRelay() } catch (e) {}
        if (offTab !== undefined) { try { offTab() } catch (e) {} }
        try { offView() } catch (e) {}
        try { offTracker() } catch (e) {}
        try { tag.remove() } catch (e) {}
        window.removeEventListener('focus', onFocus)
      }
    },
  }
  return module.exports
} })
