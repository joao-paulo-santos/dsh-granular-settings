# dsh-granular-settings

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin: install it into a profile alongside your own plugins.

**Settings that other plugins contribute.** Plugins need knobs at more than
one granularity: a model choice for this session, a build flag for the whole
workspace, an accent color for the entire install. This plugin is the shared
platform for all of them. One registration API, nine control types, three
scopes, and one Granular Settings page in the settings dialog that renders
everything, grouped one box per plugin.

Every registration is namespaced by the owning plugin's package name, so
`enabled` from `dsh-foo` and `enabled` from `dsh-bar` are different settings
in different namespaces. Generic keys are safe; collisions cannot happen.

## Three scopes, one page

| scope | value lives |
|---|---|
| `session` | one value per session, in `<workspace>/.dsh/settings/sessions/<sid>.json` |
| `workspace` | one value per workspace, shared by its sessions, in `<workspace>/.dsh/settings/workspace.json` |
| `global` | plugin-wide, unrelated to any workspace, in `~/.dsh/settings/plugins/<namespace>.json` |

The page has three tabs, Workspace, Session, Plugin, one per scope. It works
with no session open (the Plugin tab is the only scope that exists without
one). A Granular Settings view tab can also sit beside Chat in each session,
rendering the same page; its visibility is itself a plugin setting, default
on. A Plugin-tab setting can also move session/workspace storage centrally
under `~/.dsh/` instead of inside the workspace.

## How to install

Requires a DeepSeek Harness checkout and a profile, here `web`. Clone both
dependencies into a plugins folder:

```sh
mkdir -p ~/dsh-plugins && cd ~/dsh-plugins
git clone https://github.com/joao-paulo-santos/dsh-event-relay.git
git clone https://github.com/joao-paulo-santos/dsh-granular-settings.git

# from the harness checkout
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-event-relay
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-granular-settings

# verify the profile still composes
pnpm dsh --profile web --dump-config
```

Then restart the harness. The Granular Settings page appears in the settings
dialog; nothing else to wire up.

## How to use in my plugin

Host side: register controls (inject `granularSettings`):

```js
const gs = ctx.get('granularSettings')
const s = gs.register({
  namespace: 'my-plugin',       // REQUIRED: your package name, [a-z][a-z0-9-]*
  scope: 'session',             // 'session' | 'workspace' | 'global'
  key: 'model',                 // [a-z][a-z0-9-]*, unique only within the namespace
  type: 'enum',
  label: 'Model',
  owner: 'My Plugin',           // display name for the settings box
  description: 'Which model this session uses',
  options: [{ value: 'a', label: 'Model A' }],   // enum and multiselect only
  defaultValue: 'a',
  onChange: (value, target) => {},                // optional, serialized after persist
})

await s.get(sessionIdOrWorkspacePath)   // sessionId, workspace path, or ignored for global
await s.set(sessionIdOrWorkspacePath, 'b')
s.dispose()
```

Control types and their metadata:

| type | value | registration extras |
|---|---|---|
| `toggle` | boolean | |
| `text` | string, max 4000 chars | |
| `color` | hex string | |
| `number` | finite number | optional `min`, `max` |
| `slider` | number | required `min`, `max`, `step` |
| `enum` | one option value | required `options` or a provider function |
| `multiselect` | array of option values | required `options` or a provider function |
| `keybind` | combo string like `Ctrl+Alt+K` | |
| `path` | absolute directory string | |

For `enum` and `multiselect`, `options` may instead be a zero-argument
function evaluated at describe time, so an option list can track a live
library without re-registration.

Browser side: one hook, same service name as the host (inject
`granularSettings`; the browser and host planes never see each other):

```js
const gs = ctx.get('granularSettings')

// inside any component:
const [model, setModel] = gs.useSetting('my-plugin', 'session', 'model')
const [speed, setSpeed] = gs.useSetting('my-plugin', 'workspace', 'speed')
const [accent, setAccent] = gs.useSetting('my-plugin', 'global', 'accent')   // works sessionless

// keybind settings, combo handling included:
gs.useKeybind('my-plugin', 'session', 'hello', () => sayHello())
```

`useSetting` derives the session context itself, subscribes to changes
(doorbell, reconnect, window focus, write completion), serves the registration
default while a context's truth loads, and writes optimistically through
the host. With no session open, session and workspace values read as
`undefined` and their writers are no-ops; global values keep working.

Whole tabs can be contributed too, when rows are not enough:

```js
const off = gs.registerTab({ id: 'my-tab', label: 'My Plugin', order: 40 }, MyComponent)
```

The component renders inside the page's scroll area and receives the
settings-section props, `useSessions` among them. The built-in tabs sit at
order 10, 20, 30.

## Debugging

Read what the page reads, from a terminal:

```
curl 'http://127.0.0.1:3080/granular-settings/describe'
curl 'http://127.0.0.1:3080/granular-settings/describe?session=<sid>'
```

Watch the doorbells live:

```
curl -N 'http://127.0.0.1:3080/relay/events?topics=granular-settings'
```

`-N` makes curl stream instead of buffering.

## Dependencies

- [dsh-event-relay](https://github.com/joao-paulo-santos/dsh-event-relay) carries the change doorbells (hard dependency, both halves)

## Plugins dependent on this

- [dsh-bouncing-squares-example](https://github.com/joao-paulo-santos/dsh-bouncing-squares-example), the tutorial example: three bouncing squares, one per scope, exercising eight control types
