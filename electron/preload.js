// The only bridge between the page and the main process. Everything the page can ask for is
// listed here; keys, files and provider calls stay in the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
// Chat events carry the id of the request they belong to, so stray events can be ignored.
const onChat = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload, rid) => fn(payload, rid));

contextBridge.exposeInMainWorld('ilyra', {
  desktop: true,

  // AI providers and their keys (or, for local models, the server address)
  providers: invoke('providers:list'),
  saveProvider: invoke('providers:save'),
  removeProvider: invoke('providers:remove'),
  providerModels: invoke('providers:models'),
  setModel: invoke('providers:setModel'),
  openKeyPage: invoke('providers:keyPage'),
  findLocalServer: invoke('providers:findLocal'),
  warmLocal: invoke('local:warm'),
  usage: { get: invoke('usage:get') },

  // Chat
  chat: invoke('chat'),
  cancelChat: invoke('chat:cancel'),
  summarize: invoke('chat:summarize'),
  onChatStatus: onChat('chat:status'),
  onChatDelta: onChat('chat:delta'),
  onChatReset: (fn) => ipcRenderer.on('chat:reset', (_e, _payload, rid) => fn(rid)),
  onChatThinking: onChat('chat:thinking'),
  onChatTool: onChat('chat:tool'),
  onChatCode: onChat('chat:code'),
  onChatSources: onChat('chat:sources'),
  onChatImage: onChat('chat:image'),
  onChatApproval: onChat('chat:approval'),
  approvalStatus: invoke('approvals:status'),
  revokeApproval: invoke('approvals:revoke'),

  // Voice
  transcribe: invoke('transcribe'),
  speak: invoke('speak'),
  voiceLog: invoke('voice:log'),
  onVoiceStatus: (fn) => ipcRenderer.on('voice:status', (_e, text) => fn(text)),

  // Saved chats, pages and images
  chats: {
    list: invoke('chats:list'),
    get: invoke('chats:get'),
    save: invoke('chats:save'),
    remove: invoke('chats:remove'),
    pin: invoke('chats:pin'),
    search: invoke('chats:search')
  },
  openArtifact: invoke('artifact:open'),
  saveArtifact: invoke('artifact:save'),
  saveImage: invoke('image:save'),
  captureScreen: invoke('screen:capture'),

  // What Ilyra knows and may touch
  memory: { get: invoke('memory:get'), set: invoke('memory:set') },
  briefs: { get: invoke('briefs:get'), set: invoke('briefs:set') },
  folders: { list: invoke('folders:list'), add: invoke('folders:add'), remove: invoke('folders:remove') },
  tasks: { list: invoke('tasks:list'), remove: invoke('tasks:remove') },
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  connectors: {
    list: invoke('connectors:list'),
    add: invoke('connectors:add'),
    remove: invoke('connectors:remove'),
    set: invoke('connectors:set'),
    refresh: invoke('connectors:refresh'),
    signIn: invoke('connectors:signin')
  },

  // Sent by the main process: the tray, notifications and scheduled tasks
  onOpenChat: (fn) => ipcRenderer.on('app:openChat', (_e, id) => fn(id)),
  onChatsChanged: (fn) => ipcRenderer.on('app:chatsChanged', () => fn()),
  onAttachImage: (fn) => ipcRenderer.on('app:attachImage', (_e, image) => fn(image))
});
