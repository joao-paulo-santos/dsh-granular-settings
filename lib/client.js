/**
 * dsh-granular-settings — browser half (hand-authored client bundle).
 *
 * ONE surface: a "Granular Settings" page inside the global settings dialog
 * (settings.section seat, additive list). Three internal tabs:
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
 * in-flight guard + server truth from every own-call response; relay
 * subscription (prefix 'granular-settings') plus window-focus refetch keep
 * other tabs in sync.
 */
window.__ModuleLoader__.load({ id: 'dsh-granular-settings', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')

  // ---- shared module store ----
  const listeners = new Set()      // page-internal subscribers (force re-render)
  const keyListeners = new Map()   // cacheKey -> Set<fn>: SERVICE consumers
  const notify = () => { for (const fn of listeners) { try { fn() } catch (e) {} } }
  const notifyKey = (cacheKey) => {
    notify()
    const set = keyListeners.get(cacheKey)
    if (set !== undefined) { for (const fn of set) { try { fn() } catch (e) {} } }
  }
  const notifyAllKeys = () => { for (const k of keyListeners.keys()) notifyKey(k) }
  // Bridge to optional client services (set in apply): the path control uses
  // the runtime's native directory picker when present.
  const services = { getWorkspaces: () => undefined }
  const cache = new Map()          // cacheKey ('' sessionless | sessionId) -> describe response
  const wanted = new Map()         // cacheKey -> refcount: consumers that
                                   // ASKED for it (ensure/release). A key can
                                   // be wanted-but-uncached: a boot-time fetch
                                   // can 404 while host plugins still load —
                                   // the want survives that failure so the
                                   // next doorbell/reconnect/focus retries it.
  const inFlight = new Set()       // '<scope>:<key>:<cacheKey>' re-entry guards

  // One describe per key at a time: concurrent ensure/resync calls coalesce
  // into the in-flight fetch; a request arriving mid-flight marks it dirty
  // and re-runs once (freshness without stampede).
  const describing = new Map()    // cacheKey -> { dirty }
  const describe = (cacheKey) => {
    const state = describing.get(cacheKey)
    if (state !== undefined) { state.dirty = true; return }
    const st = { dirty: false }
    describing.set(cacheKey, st)
    const url = cacheKey === ''
      ? '/granular-settings/describe'
      : '/granular-settings/describe?session=' + encodeURIComponent(cacheKey)
    return fetch(url)
      .then((r) => (r.ok ? r.json() : null)).then((body) => {
        describing.delete(cacheKey)
        if (body !== null && typeof body === 'object') { cache.set(cacheKey, body); notifyKey(cacheKey) }
        if (st.dirty) describe(cacheKey)
      }, () => { describing.delete(cacheKey) })
  }

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
    const guard = ns + ':' + scope + ':' + key + ':' + cacheKey
    if (inFlight.has(guard)) return                    // Case 14: re-entry guard
    inFlight.add(guard)
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
    }).then((r) => (r.ok ? r.json() : null)).then((body) => {
      inFlight.delete(guard)
      // The response carries the stored value — apply it directly to our
      // cache (the writer's own point-to-point reply; broadcasts stay
      // doorbell-only). A refetch here would be a wasted round-trip.
      const ws = d !== undefined && typeof d.workspace === 'string' ? d.workspace : undefined
      if (body !== null && body.ok === true && ws !== undefined) {
        applyChange({ namespace: ns, scope: scope, key: key, target: scope === 'session' ? cacheKey : ws, value: body.value })
      } else {
        describe(cacheKey)                             // no cache to apply to: load truth
      }
    }, () => { inFlight.delete(guard); describe(cacheKey) })
  }

  // Apply the set-route's value echo to every cached snapshot it belongs to
  // (session scope -> that session's cache; workspace scope -> every cached
  // session in that workspace), inside the owning plugin's NAMESPACE —
  // values on the wire shape and on disk are namespaced per plugin:
  // values.<namespace>.<key>.
  const applyChange = (p) => {
    if (p === null || typeof p !== 'object' || typeof p.key !== 'string' || typeof p.namespace !== 'string') return
    let touched = false
    for (const [sid, d] of cache) {
      if (p.scope === 'global') {
        if (d.globalValues === undefined || typeof d.globalValues !== 'object') d.globalValues = {}
        if (d.globalValues[p.namespace] === undefined || typeof d.globalValues[p.namespace] !== 'object') d.globalValues[p.namespace] = {}
        d.globalValues[p.namespace][p.key] = p.value
        d.globalRevision = (typeof d.globalRevision === 'number' ? d.globalRevision : 0) + 1
        touched = true
      } else if (p.scope === 'session') {
        if (sid !== p.target) continue
        if (d.sessionValues === undefined || typeof d.sessionValues !== 'object') d.sessionValues = {}
        if (d.sessionValues[p.namespace] === undefined || typeof d.sessionValues[p.namespace] !== 'object') d.sessionValues[p.namespace] = {}
        d.sessionValues[p.namespace][p.key] = p.value
        d.sessionRevision = (typeof d.sessionRevision === 'number' ? d.sessionRevision : 0) + 1
        touched = true
      } else if (p.scope === 'workspace') {
        if (d.workspace !== p.target) continue
        if (d.workspaceValues === undefined || typeof d.workspaceValues !== 'object') d.workspaceValues = {}
        if (d.workspaceValues[p.namespace] === undefined || typeof d.workspaceValues[p.namespace] !== 'object') d.workspaceValues[p.namespace] = {}
        d.workspaceValues[p.namespace][p.key] = p.value
        d.workspaceRevision = (typeof d.workspaceRevision === 'number' ? d.workspaceRevision : 0) + 1
        touched = true
      }
    }
    if (touched) {
      notify()
      if (p.scope === 'global') { notifyAllKeys(); return }
      for (const sid of cache.keys()) notifyKey(sid)
    }
  }

  const useDescribe = (cacheKey) => {
    const [, force] = React.useState(0)
    React.useEffect(() => {
      const fn = () => force((n) => n + 1)
      listeners.add(fn)
      ensure(cacheKey)
      return () => {
        listeners.delete(fn)
        // Unmounted views drop one want: doorbells must not refetch dead
        // keys forever (refcounted — other consumers keep shared keys alive).
        release(cacheKey)
      }
    }, [cacheKey])
    return cache.get(cacheKey)
  }

  // ---- the CLIENT SERVICE (public face for other plugins' browser halves) ----
  // Consumers inject 'granularSettings' and NEVER touch fetch, the SSE relay,
  // or the wire shapes: the platform owns describe caching, doorbell push,
  // boot-safe transport attach (Case 20), and the namespaced value reader
  // (Case 18). One describe stream is shared by the page and every consumer.
  const serviceApi = {
    /** Ask for one context's settings (session id, or '' for sessionless).
     *  Idempotent + refcounted; pairs with release(). Triggers a fetch. */
    ensure,
    /** Drop one want (unmount). The shared key stays live while others want it. */
    release,
    /** Cached yet? Render gates use this to avoid default-value flash. */
    loaded: (cacheKey) => cache.has(cacheKey),
    /** Current value with default fallback; undefined while uncached.
     *  Nested read lives HERE — consumers cannot strand on shape changes. */
    valueOf(cacheKey, namespace, scope, key) {
      const d = cache.get(cacheKey)
      if (d === undefined) return undefined
      const reg = (Array.isArray(d.registrations) ? d.registrations : [])
        .find((r) => r.namespace === namespace && r.scope === scope && r.key === key)
      const values = scope === 'session'
        ? d.sessionValues : (scope === 'global' ? d.globalValues : d.workspaceValues)
      const ns = values !== null && typeof values === 'object' ? values[namespace] : undefined
      const raw = ns !== undefined && ns !== null && typeof ns === 'object' ? ns[key] : undefined
      if (raw !== undefined) return raw
      return reg !== undefined ? reg.defaultValue : undefined
    },
    /** Raw registrations for one context (scope/type/min/max/step/options). */
    registrationsOf(cacheKey) {
      const d = cache.get(cacheKey)
      return d !== undefined && Array.isArray(d.registrations) ? d.registrations : []
    },
    /** Context facts: { sessionId, workspace } when a session is attached. */
    infoOf(cacheKey) {
      const d = cache.get(cacheKey)
      if (d === undefined) return undefined
      return { sessionId: d.sessionId, workspace: d.workspace }
    },
    /** Subscribe to one context's updates (doorbell, reconnect, focus,
     *  set echo). Returns an unsubscribe function. */
    onChange(cacheKey, cb) {
      let set = keyListeners.get(cacheKey)
      if (set === undefined) { set = new Set(); keyListeners.set(cacheKey, set) }
      set.add(cb)
      return () => {
        set.delete(cb)
        if (set.size === 0) keyListeners.delete(cacheKey)
      }
    },
    /** Write a value (optimistic + serialized; same path the page uses). */
    set: (cacheKey, namespace, scope, key, value) => { setValue(cacheKey, namespace, scope, key, value) },
    /** Contribute one whole tab to the Granular Settings page.
     *  @param options { id, label, order } — id unique (duplicate throws),
     *    order positions the tab among ours (workspace 10 / session 20 /
     *    plugin 30); @param component renders the tab body inside the page's
     *    scroll area and receives this page's section props (useSessions…).
     *  @returns an exact disposer. */
    registerTab(options, component) {
      const where = 'granularSettingsClient.registerTab: '
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

  // ---- push bridge (TRANSPORT-AGNOSTIC) ----
  // A bridge converts "settings truth may be stale" world events into
  // signal() calls. The bundled bridge rides the SSE event-relay (doorbell
  // topics + '__relay' reconnect/open). Swapping transports later (websocket,
  // long-poll) means implementing this same two-function face and changing
  // ONE construction site below — consumers and the page never know.
  const createSseRelayBridge = (ctx) => {
    let stopped = false
    let detach = undefined
    let timer = 0
    let tries = 0
    const attach = (signal) => {
      const relay = ctx.get('eventRelay')
      if (relay === undefined) return false
      const offA = relay.subscribe('granular-settings', signal)
      const offB = relay.subscribe('__relay', signal)
      detach = () => { try { offA() } catch (e) {} try { offB() } catch (e) {} }
      return true   // subscribing (re)opens the stream -> '__relay/open' fires
                    // -> signal heals everything missed during the gap
    }
    return {
      start(signal) {
        if (attach(signal)) return
        timer = setInterval(() => {              // boot-safe attach (Case 20):
                                                  // the relay service may
                                                  // activate after us
          if (stopped) { if (timer !== 0) { clearInterval(timer); timer = 0 } return }
          if (attach(signal)) { clearInterval(timer); timer = 0; return }
          if (++tries > 120 && timer !== 0) { clearInterval(timer); timer = 0 }   // ~60s cap
        }, 500)
      },
      stop() {
        stopped = true
        if (timer !== 0) { clearInterval(timer); timer = 0 }
        if (detach !== undefined) { detach(); detach = undefined }
      },
    }
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
    return React.createElement('input', {
      type: 'text',
      className: 'gsv-input',
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

  const EnumField = (props) => React.createElement('select', {
    className: 'gsv-input gsv-select',
    value: typeof props.value === 'string' ? props.value : '',
    onChange: (e) => { props.onCommit(e.target.value) },
  }, (props.options || []).map((o) => React.createElement('option', {
    key: o.value, value: o.value,
  }, o.label)))

  const MultiselectField = (props) => {
    const selected = Array.isArray(props.value) ? props.value : []
    return React.createElement('div', { className: 'gsv-chips' },
      (props.options || []).map((o) => {
        const on = selected.indexOf(o.value) !== -1
        return React.createElement('button', {
          key: o.value,
          type: 'button',
          className: 'gsv-chip' + (on ? ' gsv-chip-on' : ''),
          onClick: () => {
            const next = on ? selected.filter((v) => v !== o.value) : [...selected, o.value]
            props.onCommit(next)
          },
        }, o.label)
      }))
  }

  // Keybind: click to record; next keydown becomes the binding (Backspace
  // clears, Escape cancels). Normalized "Ctrl+Alt+Shift+Meta order + KEY".
  const comboOf = (e) => {
    const parts = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Meta')
    let key = e.key
    if (key === ' ') key = 'Space'
    if (key.length === 1) key = key.toUpperCase()
    parts.push(key)
    return parts.join('+')
  }
  const KeybindField = (props) => {
    const [recording, setRecording] = React.useState(false)
    React.useEffect(() => {
      if (recording !== true) return
      const onKeyDown = (e) => {
        e.preventDefault(); e.stopPropagation()
        if (e.key === 'Escape') { setRecording(false); return }
        if (e.key === 'Backspace') { props.onCommit(''); setRecording(false); return }
        props.onCommit(comboOf(e))
        setRecording(false)
      }
      document.addEventListener('keydown', onKeyDown, true)
      return () => { document.removeEventListener('keydown', onKeyDown, true) }
    }, [recording])
    return React.createElement('button', {
      type: 'button',
      className: 'gsv-input gsv-keybind' + (recording ? ' gsv-keybind-rec' : ''),
      onClick: () => { setRecording(!recording) },
    }, recording ? 'Press keys… (Esc cancels, Backspace clears)'
      : (typeof props.value === 'string' && props.value !== '' ? props.value : 'Not set — click to record'))
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

  const Row = (props) => React.createElement('div', { className: 'gsv-row' },
    React.createElement('div', { className: 'gsv-row-main' },
      React.createElement('div', { className: 'gsv-row-title' }, props.reg.label),
      props.reg.description !== undefined
        ? React.createElement('div', { className: 'gsv-row-desc' }, props.reg.description)
        : null),
    React.createElement('div', { className: 'gsv-control' },
      props.reg.type === 'toggle'
        ? React.createElement('div', { className: 'gsv-toggle' },
            React.createElement('span', {
              className: 'gsv-state' + (props.value === true ? ' gsv-state-on' : ''),
              style: props.value === true ? { color: BLUE } : undefined,
            }, props.value === true ? 'On' : 'Off'),
            React.createElement(Switch, {
              value: props.value === true,
              busy: props.busy,
              onChange: () => { props.onSet(props.reg, props.value !== true) },
            }))
        : props.reg.type === 'color'
          ? React.createElement(ColorField, {
              value: typeof props.value === 'string' ? props.value : '',
              busy: props.busy,
              onCommit: (hex) => { props.onSet(props.reg, hex) },
            })
          : props.reg.type === 'number' || props.reg.type === 'slider'
            ? (props.reg.type === 'number'
                ? React.createElement(NumberField, {
                    value: typeof props.value === 'number' ? props.value : 0,
                    min: props.reg.min, max: props.reg.max, step: props.reg.step,
                    onCommit: (n) => { props.onSet(props.reg, n) },
                  })
                : React.createElement(SliderField, {
                    value: typeof props.value === 'number' ? props.value : (props.reg.min || 0),
                    min: props.reg.min, max: props.reg.max, step: props.reg.step,
                    onCommit: (n) => { props.onSet(props.reg, n) },
                  }))
            : props.reg.type === 'enum'
              ? React.createElement(EnumField, {
                  value: typeof props.value === 'string' ? props.value : '',
                  options: props.reg.options,
                  onCommit: (v) => { props.onSet(props.reg, v) },
                })
              : props.reg.type === 'multiselect'
                ? React.createElement(MultiselectField, {
                    value: Array.isArray(props.value) ? props.value : [],
                    options: props.reg.options,
                    onCommit: (v) => { props.onSet(props.reg, v) },
                  })
                : props.reg.type === 'keybind'
                  ? React.createElement(KeybindField, {
                      value: typeof props.value === 'string' ? props.value : '',
                      onCommit: (v) => { props.onSet(props.reg, v) },
                    })
                  : props.reg.type === 'path'
                    ? React.createElement(PathField, {
                        value: typeof props.value === 'string' ? props.value : '',
                        onCommit: (v) => { props.onSet(props.reg, v) },
                      })
                    : React.createElement(TextField, {
                        value: typeof props.value === 'string' ? props.value : '',
                        busy: props.busy,
                        onCommit: (text) => { props.onSet(props.reg, text) },
                      })))

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

  // A registration's current value lives under values.<namespace>.<key>.
  const valueOf = (values, reg) => {
    if (values !== undefined && values !== null && typeof values === 'object') {
      const ns = values[reg.namespace]
      if (ns !== undefined && ns !== null && typeof ns === 'object') {
        const v = ns[reg.key]
        if (v !== undefined) return v
      }
    }
    return reg.defaultValue
  }

  const PluginBox = (props) => React.createElement('div', { className: 'gsv-plugin' },
    React.createElement('div', { className: 'gsv-plugin-head' }, props.group.owner),
    React.createElement('div', { className: 'gsv-rows' },
      props.group.regs.map((reg) => React.createElement(Row, {
        key: reg.key,
        reg: reg,
        value: valueOf(props.values, reg),
        busy: props.busyOf(reg),
        onSet: props.onSet,
      }))))

  const Section = (props) => {
    const body = props.regs.length === 0
      ? React.createElement('p', { className: 'gsv-empty' }, props.emptyCopy)
      : groupByNamespace(props.regs).map((group) => React.createElement(PluginBox, {
          key: group.ns,
          group: group,
          values: props.values,
          busyOf: props.busyOf,
          onSet: props.onSet,
        }))
    return React.createElement('section', { className: 'gsv-section' },
      React.createElement('h3', { className: 'gsv-h3' }, props.title),
      props.subtitle !== undefined
        ? React.createElement('p', { className: 'gsv-sub' }, props.subtitle)
        : null,
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
  // whole tabs through granularSettingsClient.registerTab({id,label,order},
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
    const onSetFactory = (scope) => (reg, value) => { setValue(cacheKey, reg.namespace, scope, reg.key, value) }
    const busyFactory = (scope) => (reg) => inFlight.has(reg.namespace + ':' + scope + ':' + reg.key + ':' + cacheKey)

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
      return React.createElement('div', { className: 'gsv-page' }, header,
        React.createElement('div', { className: 'gsv-scroll' },
          React.createElement(activeEntry.component, props)))
    }
    if (d === undefined) {
      return React.createElement('div', { className: 'gsv-page' }, header,
        React.createElement('div', { className: 'gsv-scroll' },
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
          values: d.globalValues !== undefined ? d.globalValues : {},
          busyOf: busyFactory('global'),
          onSet: onSetFactory('global'),
          emptyCopy: 'No plugin settings registered yet.',
        }))
    } else if (effectiveTab === 'workspace') {
      body = React.createElement('div', { className: 'gsv-sections' },
        React.createElement(Section, {
          title: 'Workspace',
          subtitle: 'Apply to every session in ' + (typeof d.workspace === 'string' ? d.workspace : 'this workspace') + '.',
          regs: regs.filter((r) => r.scope === 'workspace'),
          values: d.workspaceValues !== undefined ? d.workspaceValues : {},
          busyOf: busyFactory('workspace'),
          onSet: onSetFactory('workspace'),
          emptyCopy: 'No workspace settings registered by plugins yet.',
        }))
    } else {
      // (session tab — the default)
      body = React.createElement('div', { className: 'gsv-sections' },
        React.createElement(Section, {
          title: 'This session',
          subtitle: 'Apply to the current session only.',
          regs: regs.filter((r) => r.scope === 'session'),
          values: d.sessionValues !== undefined ? d.sessionValues : {},
          busyOf: busyFactory('session'),
          onSet: onSetFactory('session'),
          emptyCopy: 'No session settings registered by plugins yet.',
        }))
    }
    return React.createElement('div', { className: 'gsv-page' }, header,
      React.createElement('div', { className: 'gsv-scroll' }, body))
  }

  module.exports = {
    name: 'granular-settings-client',
    inject: ['slots'],
    apply(ctx) {
      services.getWorkspaces = () => ctx.get('workspaces')
      // Client-plane service name is DISTINCT from the host service name:
      // 'granularSettingsClient'. The host's 'granularSettings' is a host-plane
      // registry entry; reusing the name client-side invites shadowing
      // ambiguity (and any future host-service mirroring). Consumers inject
      // 'granularSettingsClient' + 'slots'.
      ctx.provide('granularSettingsClient', serviceApi)
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
        '.gsv-select{width:auto;min-width:140px;cursor:pointer}',
        '.gsv-chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;max-width:min(320px,60%)}',
        '.gsv-chip{font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-label-tertiary);opacity:.7}',
        '.gsv-chip:hover{opacity:1}',
        '.gsv-chip-on{opacity:1;border-color:#3b82f6;color:#3b82f6;font-weight:600}',
        '.gsv-keybind{cursor:pointer;text-align:center;min-width:200px;font-family:ui-monospace,monospace;font-size:12px}',
        '.gsv-keybind-rec{border-color:#3b82f6;color:#3b82f6;font-style:italic}',
        '.gsv-path{display:flex;align-items:center;gap:8px;max-width:min(340px,60%)}',
        '.gsv-path-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.75;font-family:ui-monospace,monospace}',
        '.gsv-path-btn{font-size:12px;padding:5px 10px}',
        '.gsv-empty{margin:0;padding:18px;font-size:13px;opacity:.55;border:1px dashed var(--dsw-alias-label-tertiary);border-radius:12px;text-align:center}',
      ].join('')
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-granular-settings'
      tag.textContent = css
      document.head.appendChild(tag)

      // Push arrives through the BRIDGE (transport detail, above); the focus
      // listener remains the transport-independent pull fallback.
      let bridgeRef = undefined
      const onFocus = () => { onStale() }
      window.addEventListener('focus', onFocus)

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

      // Stale signal: bridge push and focus pull converge here.
      const onStale = () => { resync(); evalTab() }
      const bridge = createSseRelayBridge(ctx)
      bridge.start(onStale)
      bridgeRef = bridge

      return () => {
        if (bridgeRef !== undefined) { try { bridgeRef.stop() } catch (e) {} }
        if (offTab !== undefined) { try { offTab() } catch (e) {} }
        try { offView() } catch (e) {}
        try { tag.remove() } catch (e) {}
        window.removeEventListener('focus', onFocus)
      }
    },
  }
  return module.exports
} })
