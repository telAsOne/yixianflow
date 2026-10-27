<template>
  <div class="promptInputWrap nodrag nopan nowheel">
    <el-button v-if="expandable" class="expandButton" :icon="IconMaximize" text circle title="展开编辑提示词" aria-label="展开编辑提示词" @mousedown.prevent @click.stop="expanded = true" />
    <teleport :to="expandedTarget || 'body'" :disabled="!expanded || !expandedTarget">
      <div ref="senderElement" class="promptInput nodrag nopan nowheel" :class="{ expandedInput: expanded }" @keydown.capture="handleMentionKey" @click.capture="previewReference" />
    </teleport>
  </div>
  <el-dialog v-if="expandable" v-model="expanded" class="promptEditorDialog" title="生成提示词" width="80%" alignCenter appendToBody :closeOnClickModal="false" @opened="sender?.focus('mark')" @close="expanded = false" @closed="sender?.focus('mark')">
    <div ref="expandedTarget" class="promptExpandedTarget nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop />
  </el-dialog>
  <el-image-viewer v-if="previewUrl" :urlList="[previewUrl]" teleported @close="previewReferenceId = undefined" />
  <teleport v-if="mentionTarget" :to="mentionTarget">
    <div class="referenceColumns" @mousedown.prevent @pointerdown.stop @wheel.stop @keydown.stop="handleMentionKey">
      <section v-for="group in mentionGroups" :key="group.label" class="referenceColumn" :aria-label="group.label">
        <h4>{{ group.label }} <span>{{ group.items.length }}</span></h4>
        <div class="referenceOptions" role="listbox" :aria-label="group.label">
          <button v-for="item in group.items" :key="item.id" type="button" class="referenceOption" :class="{ active: activeMentionId === item.id }" :data-id="item.id" role="option" :aria-selected="activeMentionId === item.id" :title="`${item.name} · ${item.value}`" @mouseenter="activeMentionId = item.id" @click.stop="insertReference(item)">
            <img v-if="item.avatar" :src="String(item.avatar)" alt="" />
            <span><strong>{{ item.name }}</strong><small>{{ item.value }}</small></span>
          </button>
        </div>
      </section>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ElButton, ElDialog, ElImageViewer, useZIndex } from "element-plus";
import { IconMaximize } from "@tabler/icons-vue";
import xSender, { type AnyTagProps, type MentionItem } from "x-sender";
import "x-sender/lib/XSender.css";

type PromptReference = MentionItem & { value: string; previewUrl?: string; category?: string; action?: boolean };
const props = defineProps<{ references: PromptReference[]; referenceGroups?: { label: string; categories: string[] }[]; expandable?: boolean; placeholder?: string; recognizeTokens?: boolean; preserveMissingReferences?: boolean; disabled?: boolean; maxHeight?: string }>();
const emit = defineEmits<{ activateReference: [reference: PromptReference, occurrence: number]; insertReference: [reference: PromptReference, offset: number] }>();
const model = defineModel<AnyTagProps[][]>({ required: true });
const text = defineModel<string>("text", { default: "" });
const senderElement = ref<HTMLElement>();
const expanded = ref(false);
const expandedTarget = ref<HTMLElement>();
const mentionTarget = ref<HTMLElement>();
const mentionMatches = ref<string[]>([]);
const activeMentionId = ref<string>();
const mentionGroups = computed(() => {
  const matches = new Set(mentionMatches.value);
  return (props.referenceGroups ?? []).map(group => ({ label: group.label, items: props.references.filter(item => matches.has(item.id) && group.categories.includes(item.category ?? "")) })).filter(group => group.items.length);
});
const { nextZIndex } = useZIndex();
const previewReferenceId = ref<string>();
const previewUrl = computed(() => {
  const reference = props.references.find(item => item.id === previewReferenceId.value);
  return String(reference?.previewUrl || reference?.avatar || "");
});
let sender: xSender | undefined;
let resetTask: Promise<void> | undefined;
const tokenPattern = computed(() => props.recognizeTokens && props.references.length
  ? new RegExp(`(${[...new Set(props.references.filter(item => !item.action).map(item => item.value))].filter(Boolean).sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g")
  : /(\{\{ref \d+\}\})/g);

function selectionOffset(node: Node | null, offset: number) {
  if (!sender) return;
  const value = sender.getModel();
  if (node === sender.chatElement.richText) return getPromptText(value.slice(0, offset)).length + (offset > 0 && offset < value.length ? 1 : 0);
  const row = sender.chatEditor.NODES.findIndex(grid => grid.$el.contains(node));
  if (row < 0) return;
  const grid = sender.chatEditor.NODES[row];
  const start = row ? getPromptText(value.slice(0, row)).length + 1 : 0;
  if (node === grid.$el) return start + getPromptText([value[row].slice(0, offset)]).length;
  const column = grid.children.findIndex(child => child.$el.contains(node));
  if (column < 0) return;
  const child = grid.children[column];
  const range = document.createRange();
  range.selectNodeContents(child.$el);
  range.setEnd(node!, offset);
  const length = getPromptText([[value[row][column]]]).length;
  const local = child.type === "Write" || child.type === "Input" ? range.toString().replace(/[\uFEFF\u200B]/g, "").length : offset ? length : 0;
  return start + getPromptText([value[row].slice(0, column)]).length + Math.min(length, local);
}

function getSelection() {
  const selection = sender?.getSelection();
  if (!selection?.rangeCount) return;
  const anchor = selectionOffset(selection.anchorNode, selection.anchorOffset);
  const focus = selectionOffset(selection.focusNode, selection.focusOffset);
  if (anchor !== undefined && focus !== undefined) return { anchor, focus };
}

function restoreSelection(selection: { anchor: number; focus: number }) {
  const instance = sender;
  if (!instance || props.disabled) return;
  const value = instance.getModel();
  const length = getPromptText(value).length;
  const endpoint = (position: number) => {
    let offset = Math.max(0, Math.min(length, position));
    for (const [row, grid] of instance.chatEditor.NODES.entries()) {
      for (const [column, target] of grid.children.entries()) {
        const size = getPromptText([[value[row][column]]]).length;
        if ((target.type === "Write" || target.type === "Input") && offset <= size) {
          const node = target.type === "Write" ? target.$el.children[0].firstChild : target.$el.children[0].children[0].firstChild;
          if (!node) return;
          // XSender 用零宽字符承载空行及内部换行，历史位置只计算实际提示词。
          let domOffset = 0;
          let remaining = Math.min(target.text.length, Math.max(0, offset));
          for (const character of node.textContent ?? "") {
            if (character !== "\uFEFF" && character !== "\u200B") {
              if (remaining <= 0) break;
              remaining -= character.length;
            }
            domOffset += character.length;
          }
          return { target, node, offset: domOffset };
        }
        offset -= size;
      }
      offset--;
    }
  };
  const anchor = endpoint(selection.anchor);
  const focus = endpoint(selection.focus);
  if (!anchor || !focus) return;
  focus.target.focus(focus.offset);
  instance.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

function caretOffset() {
  const cursor = sender?.getCurrentNode();
  return getSelection()?.focus ?? (cursor && selectionOffset(cursor.node, cursor.offset));
}

defineExpose({
  getCaretOffset: caretOffset,
  getSelection,
  restoreSelection,
  replaceText(value: string) { syncModel(value.split("\n").map(text => [{ type: "Write", text }])); },
  async insertText(value: string) {
    if (!sender || props.disabled) return;
    sender.focus("mark");
    await sender.setText(value);
    syncModel();
  },
});

function previewReference(event: MouseEvent) {
  const tag = event.target instanceof Element ? event.target.closest<HTMLElement>(".imageReference[data-reference-id]") : null;
  const reference = props.references.find(item => item.id === tag?.dataset.referenceId);
  if (reference) {
    const matches = Array.from(senderElement.value?.querySelectorAll<HTMLElement>(".imageReference") ?? []).filter(item => item.dataset.value === reference.value);
    emit("activateReference", reference, Math.max(0, matches.indexOf(tag!)));
  }
  if (!reference?.avatar) return;
  event.preventDefault();
  event.stopPropagation();
  sender?.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
  previewReferenceId.value = reference.id;
}

function referenceHtml(reference: PromptReference) {
  const tag = document.createElement("span");
  tag.className = "imageReference";
  tag.dataset.referenceId = reference.id;
  tag.dataset.value = reference.value;
  if (reference.category) tag.dataset.category = reference.category;
  if (reference.avatar) {
    const image = document.createElement("img");
    image.src = String(reference.avatar);
    image.alt = "";
    image.draggable = false;
    tag.append(image);
  }
  tag.append(document.createTextNode(reference.name));
  return tag.outerHTML;
}

function normalizeModel(value: AnyTagProps[][]): AnyTagProps[][] {
  if (!value.length) return [[{ type: "Write", text: "" }]];
  return value.map(line => {
    const tags = line.flatMap((tag): AnyTagProps[] => {
      if (tag.type === "Write") return tag.text.split(tokenPattern.value).map(text => {
        const reference = props.references.find(item => !item.action && item.value === text);
        return reference
          ? { type: "Custom", html: `<span style="display: inline-block;">${referenceHtml(reference)}</span>` }
          : { type: "Write", text };
      });
      if (tag.type !== "Custom") return [tag];
      const template = document.createElement("template");
      template.innerHTML = tag.html;
      const element = template.content.querySelector<HTMLElement>(".imageReference[data-reference-id]");
      const id = element?.dataset.referenceId;
      if (!id) return [tag];
      const reference = props.references.find(item => item.id === id);
      if (!reference) return props.preserveMissingReferences || element?.dataset.category ? [{ type: "Write", text: element?.dataset.value ?? "" }] : [];
      return [{ type: "Custom", html: `<span style="display: inline-block;">${referenceHtml(reference)}</span>` }];
    });
    const next: AnyTagProps[] = [{ type: "Write", text: "" }];
    for (const tag of tags) {
      const previous = next[next.length - 1];
      if (tag.type === "Write" && previous.type === "Write") previous.text += tag.text;
      else {
        if (tag.type !== "Write" && previous.type !== "Write") next.push({ type: "Write", text: "" });
        next.push(tag);
      }
    }
    if (next[next.length - 1].type !== "Write") next.push({ type: "Write", text: "" });
    return next;
  });
}

function releaseNodeFocus(instance: xSender) {
  // ACT: 1.4.6 的排队输入回调仍会聚焦旧 Write；仅让即将移除的节点失效，库支持取消回调后可移除。
  for (const grid of instance.chatEditor.NODES) {
    for (const node of grid.children) {
      if (node.type === "Write" || node.type === "Input") node.focus = () => {};
    }
  }
}

function syncModel(value = sender?.getModel() ?? model.value) {
  // 输入法组字时只同步文本，等 compositionend 后再替换参考标签，保留正在编辑的 DOM。
  const next = sender?.chatEditor.isComposition ? value : normalizeModel(value);
  if (sender && JSON.stringify(sender.getModel()) !== JSON.stringify(next)) {
    const instance = sender;
    const editor = instance.chatElement.richText;
    const selection = instance.getSelection();
    const focused = document.activeElement === editor;
    const endpoints = focused ? [selection.anchorNode, selection.focusNode].map((node, index) => {
      const gridIndex = instance.chatEditor.NODES.findIndex(grid => grid.$el.contains(node));
      const grid = instance.chatEditor.NODES[gridIndex];
      const childIndex = grid?.children.findIndex(child => child.$el.contains(node)) ?? -1;
      const child = grid?.children[childIndex];
      return {
        gridIndex, childIndex,
        text: child?.type === "Write" || child?.type === "Input" ? child.text : undefined,
        offset: index ? selection.focusOffset : selection.anchorOffset,
      };
    }) : [];
    releaseNodeFocus(instance);
    const task = instance.reset({ chatNode: next, clearHistory: false });
    resetTask = task;
    void task.finally(() => { if (resetTask === task) resetTask = undefined; });
    // ACT: reset 同步重建 DOM，但下一帧会强制移到末尾；在此恢复选区，并在 reset 完成前抑制该次聚焦。
    const last = instance.chatEditor.NODES.at(-1)?.children.at(-1);
    if (last?.type === "Write") {
      Object.assign(instance.getCurrentNode(), { instance: last, node: last.$el.children[0].firstChild, offset: last.text.length || 1 });
    }
    const restored = endpoints.map(endpoint => {
      const target = instance.chatEditor.NODES[endpoint.gridIndex]?.children[endpoint.childIndex];
      if ((target?.type !== "Write" && target?.type !== "Input") || target.text !== endpoint.text) return;
      const node = target.type === "Write" ? target.$el.children[0].firstChild : target.$el.children[0].children[0].firstChild;
      if (node?.nodeType !== Node.TEXT_NODE || endpoint.offset > (node.textContent?.length ?? 0)) return;
      return { target, node, offset: endpoint.offset };
    });
    const [anchor, focus] = restored;
    if (anchor && focus) {
      focus.target.focus(focus.offset);
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } else if (focused && last?.type === "Write") last.focus(-1);
  }
  model.value = next;
  text.value = getPromptText(next);
}

function getPromptText(value: AnyTagProps[][]) {
  return value.map(line => line.map(tag => {
    if (tag.type === "Write") return tag.text;
    if (tag.type === "Input") return tag.text || tag.placeholder;
    if (tag.type !== "Custom") {
      const prefix = tag.type === "Mention" ? "@" : tag.type === "Trigger" ? tag.key : "";
      return prefix + tag.name;
    }
    const content = document.createElement("template");
    content.innerHTML = tag.html;
    for (const reference of content.content.querySelectorAll<HTMLElement>(".imageReference[data-value]")) {
      reference.replaceWith(reference.dataset.value ?? "");
    }
    return content.content.textContent ?? "";
  }).join("")).join("\n");
}

watch(model, (value) => {
  if (sender && JSON.stringify(value) !== JSON.stringify(sender.getModel())) syncModel(value);
}, { deep: true });

watch(() => props.references, async (options) => {
  const instance = sender;
  if (!instance) return;
  instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
  instance.updateConfig({ mentionConfig: { dialogTitle: "选择参考", callEvery: false, options } });
  // 等库将本帧的输入 DOM 写回模型后再更新参考，避免用旧文本重建输入框。
  await instance.nextTick();
  if (sender === instance) syncModel();
}, { deep: true });

watch(senderElement, (element, _previous, onCleanup) => {
  if (!element) return;
  const popup = document.createElement("div");
  popup.className = "textNodeMentions nodrag nopan nowheel";
  popup.style.zIndex = String(nextZIndex());
  document.body.appendChild(popup);
  const initialModel: AnyTagProps[][] = model.value.length ? model.value : text.value.split("\n").map(text => [{ type: "Write", text }]);
  const instance = new xSender(element, {
    autoFocus: false,
    placeholder: props.placeholder ?? "描述一下生成风格提示词，输入 @ 引用参考",
    chatStyle: { minHeight: "54px", maxHeight: props.maxHeight ?? "180px", fontSize: "14px", lineHeight: "1.6" },
    getPopupContainer: () => popup,
    mentionConfig: { dialogTitle: "选择参考", callEvery: false, options: props.references },
    keyboardSendFun: () => false,
    keyboardWrapFun: event => event.key === "Enter" && !event.isComposing,
  });
  sender = instance;
  // ACT: XSender 1.4.6 没有候选渲染插槽；保留其匹配与光标协议，仅替换分组候选视图。
  const mentionDialog = instance.chatElement.dialogRoot.querySelector<HTMLElement>(".chat-mention-dialog-wrap")!;
  let mentionObserver: MutationObserver | undefined;
  if (props.referenceGroups) {
    mentionDialog.classList.add("groupedMentions");
    const target = document.createElement("div");
    mentionDialog.appendChild(target);
    mentionTarget.value = target;
    const updateMentions = () => {
      const matches = Array.from(mentionDialog.querySelectorAll<HTMLElement>(".chat-mention-dialog-main > .chat-mention-dialog-item.chat-view-show"), item => item.dataset.id!);
      if (matches.join("\0") !== mentionMatches.value.join("\0")) mentionMatches.value = matches;
      if (!matches.includes(activeMentionId.value ?? "")) activeMentionId.value = matches[0];
      void nextTick(() => {
        if (sender !== instance || !mentionDialog.classList.contains("chat-view-show")) return;
        const selection = instance.getSelection();
        if (!selection.rangeCount) return;
        const caret = selection.getRangeAt(0).getBoundingClientRect();
        const width = mentionDialog.offsetWidth;
        const height = mentionDialog.offsetHeight;
        const left = Math.max(8, Math.min(caret.left, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(caret.top >= height + 8 ? caret.top - height - 8 : caret.bottom + 8, window.innerHeight - height - 8));
        for (const [key, value] of Object.entries({ position: "fixed", left: `${left}px`, top: `${top}px`, bottom: "auto" })) {
          if (mentionDialog.style.getPropertyValue(key) !== value) mentionDialog.style.setProperty(key, value);
        }
      });
    };
    mentionObserver = new MutationObserver(updateMentions);
    mentionObserver.observe(mentionDialog, { attributes: true, attributeFilter: ["class", "style"] });
    mentionObserver.observe(mentionDialog.children[1], { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    updateMentions();
  }
  const stopDisabledWatch = watch(() => props.disabled, disabled => disabled ? instance.disable() : instance.enable(), { immediate: true });
  // ACT: 弹窗只移动现有编辑器，保留参考标签、光标与撤销记录。
  const stopExpandedWatch = watch([expanded, expandedTarget, () => props.maxHeight], async ([visible]) => {
    instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
    instance.updateConfig({ chatStyle: { minHeight: visible ? "100%" : "54px", maxHeight: visible ? "100%" : props.maxHeight ?? "180px" } });
    await nextTick();
    if (sender !== instance) return;
    popup.style.zIndex = String(nextZIndex());
  });
  const editor = instance.chatElement.richText;
  // ACT: 1.4.6 未检查卸载节点和空 Range 矩形；只适配当前实例，升级到库内修复后可移除。
  const chatEditor = instance.chatEditor as typeof instance.chatEditor & {
    undoHistory: { nodes: AnyTagProps[][]; selection?: { anchor: number; focus: number } }[];
    redoHistory: { nodes: AnyTagProps[][]; selection?: { anchor: number; focus: number } }[];
    focusFirst(): void;
    focusLast(): void;
    focusMark(): void;
    cursorView(): void;
    insertNodes(nodes: AnyTagProps[][]): Promise<void>;
  };
  // ACT: XSender 1.4.6 只记录上次输入后的光标；沿用其 50 条历史，补记本次编辑前的选区。
  const captureHistorySelection = () => {
    const entry = chatEditor.undoHistory.at(-1);
    if (entry && JSON.stringify(entry.nodes) === JSON.stringify(instance.getModel())) entry.selection = getSelection() ?? entry.selection;
  };
  let restoringHistory = false;
  const restoreHistory = async (event: KeyboardEvent) => {
    if (props.disabled || event.isComposing || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    const historyKey = (event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y");
    if (!historyKey) { captureHistorySelection(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (restoringHistory) return;
    restoringHistory = true;
    try {
      await instance.nextTick();
      if (sender !== instance) return;
      captureHistorySelection();
      const redo = key === "y" || event.shiftKey;
      const entry = redo ? chatEditor.redoHistory.at(-1) : chatEditor.undoHistory.at(-2);
      if (!entry) return;
      await (redo ? instance.redo() : instance.undo());
      await resetTask;
      if (sender === instance && entry.selection) restoreSelection(entry.selection);
    } finally { restoringHistory = false; }
  };
  editor.addEventListener("beforeinput", captureHistorySelection, true);
  editor.addEventListener("paste", captureHistorySelection, true);
  editor.addEventListener("cut", captureHistorySelection, true);
  editor.addEventListener("keydown", restoreHistory, true);
  for (const method of ["focusFirst", "focusLast", "focusMark"] as const) {
    const focus = chatEditor[method].bind(chatEditor);
    chatEditor[method] = () => {
      if (sender !== instance || !editor.isConnected || !editor.getClientRects().length) return;
      if (method === "focusLast" && resetTask) return;
      if (method === "focusMark" && !editor.contains(instance.getCurrentNode().node)) return chatEditor.focusLast();
      focus();
    };
  }
  const cursorView = chatEditor.cursorView.bind(chatEditor);
  chatEditor.cursorView = () => {
    const selection = instance.getSelection();
    if (sender !== instance || !editor.isConnected || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) || !range.getClientRects().length || !editor.parentElement?.getClientRects().length) return;
    cursorView();
  };
  const insertNodes = chatEditor.insertNodes.bind(chatEditor);
  chatEditor.insertNodes = async nodes => {
    // 选区粘贴会先异步删除，再插入；关闭输入框后不再创建并聚焦新节点。
    if (sender === instance && editor.isConnected) await insertNodes(nodes);
  };
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "生成提示词");
  editor.setAttribute("aria-multiline", "true");
  instance.bus.on("textPrompt", xSender.EventSet.EVENT_COMMON_CHANGE, () => syncModel());
  syncModel(initialModel);
  // ACT: XSender 1.4.6 默认复制标签名称；复用库截取的选区模型，仅覆盖纯文本，保留富文本粘贴。
  const copyText = (event: ClipboardEvent) => {
    const copied = event.clipboardData?.getData("application/chat-nodes");
    if (copied) event.clipboardData?.setData("text/plain", getPromptText(JSON.parse(copied)));
  };
  editor.addEventListener("copy", copyText);
  editor.addEventListener("cut", copyText);
  const selectReference = (event: MouseEvent) => {
    const item = (event.target as Element).closest<HTMLElement>(".chat-mention-dialog-item");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const reference = props.references.find(reference => reference.id === item.dataset.id);
    if (reference) void insertReference(reference);
  };
  const closeOutside = (event: PointerEvent) => {
    if (!element.contains(event.target as Node) && !popup.contains(event.target as Node)) {
      instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
    }
  };
  // ACT: XSender 1.4.6 的候选默认插入 Mention；捕获选择事件改用公开 setHtml，库支持自定义渲染后可替换。
  popup.addEventListener("click", selectReference, true);
  document.addEventListener("pointerdown", closeOutside, true);
  onCleanup(() => {
    mentionObserver?.disconnect();
    mentionTarget.value = undefined;
    stopDisabledWatch();
    stopExpandedWatch();
    model.value = instance.getModel();
    releaseNodeFocus(instance);
    sender = undefined;
    editor.removeEventListener("copy", copyText);
    editor.removeEventListener("cut", copyText);
    editor.removeEventListener("beforeinput", captureHistorySelection, true);
    editor.removeEventListener("paste", captureHistorySelection, true);
    editor.removeEventListener("cut", captureHistorySelection, true);
    editor.removeEventListener("keydown", restoreHistory, true);
    document.removeEventListener("pointerdown", closeOutside, true);
    popup.removeEventListener("click", selectReference, true);
    // ACT: 1.4.6 的 destroy 会删除排队回调仍需用到的字段；先走公开清理事件，库修复后可直接 destroy。
    instance.bus.offKeyEvent("textPrompt");
    instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
    instance.updateConfig({ mentionConfig: { dialogTitle: "选择参考", callEvery: false, options: [] } });
    instance.bus.emit(xSender.EventSet.EVENT_COMMON_DESTROY);
    popup.remove();
  });
});

async function insertReference(reference: MentionItem) {
  const instance = sender;
  if (!instance) return;
  const cursor = instance.getCurrentNode();
  const before = cursor.node.textContent?.slice(0, cursor.offset) ?? "";
  const start = before.lastIndexOf("@");
  if (start < 0) return;
  instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
  const current = props.references.find(item => item.id === reference.id);
  if (sender === instance && current) {
    const offset = Math.max(0, (caretOffset() ?? text.value.length) - (before.length - start));
    // ACT: 沿用 1.4.6 自带候选的 del 协议，一次替换 @ 查询；分两次删除、插入会被异步光标恢复打断。
    const insertion = new Promise<void>(resolve => instance.bus.emit(xSender.EventSet.EVENT_EDITOR_INSERT_CUSTOM, { html: `<span style="display: inline-block;">${referenceHtml(current)}</span>`, del: before.length - start }, resolve));
    // 插入已同步写入库模型，但 change 要等下一帧；先同步正文，避免紧接着移除素材时读到旧的 @ 查询。
    const inserted = instance.getModel();
    model.value = inserted;
    text.value = getPromptText(inserted);
    await insertion;
    if (sender !== instance) return;
    syncModel();
    emit("insertReference", current, offset);
  }
}

function handleMentionKey(event: KeyboardEvent) {
  if (!sender || event.isComposing || !["ArrowUp", "ArrowDown", "Enter", "Escape", ...(props.referenceGroups ? ["ArrowLeft", "ArrowRight"] : [])].includes(event.key)) return;
  const dialog = sender.chatElement.dialogRoot.querySelector<HTMLElement>(".chat-mention-dialog-wrap");
  if (!dialog?.getClientRects().length) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    sender.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
    return;
  }
  if (props.referenceGroups) {
    const groups = mentionGroups.value;
    if (!groups.length) return;
    const column = Math.max(0, groups.findIndex(group => group.items.some(item => item.id === activeMentionId.value)));
    const row = Math.max(0, groups[column].items.findIndex(item => item.id === activeMentionId.value));
    if (event.key === "Enter") { void insertReference(groups[column].items[row]); return; }
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const direction = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const items = groups[horizontal ? (column + direction + groups.length) % groups.length : column].items;
    activeMentionId.value = items[horizontal ? Math.min(row, items.length - 1) : (row + direction + items.length) % items.length].id;
    void nextTick(() => mentionTarget.value?.querySelector(".referenceOption.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    return;
  }
  // ACT: 1.4.6 的候选键盘监听在 window，会被骨架截断；只适配当前实例，库支持局部键盘 API 后可替换。
  const items = Array.from(dialog.querySelectorAll<HTMLElement>(".chat-mention-dialog-item")).filter(item => item.getClientRects().length);
  if (!items.length) return;
  const active = Math.max(0, items.findIndex(item => item.classList.contains("active")));
  if (event.key === "Enter") {
    items[active]?.click();
    return;
  }
  const next = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items.forEach((item, index) => item.classList.toggle("active", index === next));
  items[next]?.scrollIntoView({ block: "nearest" });
}
</script>

<style scoped lang="scss">
.promptInputWrap {
  position: relative;
  margin: 12px 0 16px;

  .expandButton {
    position: absolute;
    top: 2px;
    right: 10px;
    z-index: 11;
    width: 24px;
    height: 24px;
    padding: 4px;
    color: var(--el-text-color-secondary);
  }

  &:has(.expandButton) .promptInput {
    :deep(.chat-rich-text > [contenteditable]),
    :deep(.chat-placeholder-wrap) { padding-right: 34px; }
  }
}

:global(.promptEditorDialog) {
  display: flex;
  flex-direction: column;
  height: 80vh;
}

:global(.promptEditorDialog .el-dialog__body) { flex: 1; min-height: 0; }
.promptExpandedTarget { height: 100%; }

.promptInput,
:global(.textNodeMentions) {
  --chat-primary: var(--el-color-primary);
  --chat-text: var(--el-text-color-primary);
  --chat-text-secondary: var(--el-text-color-regular);
  --chat-text-placeholder: var(--el-text-color-placeholder);
  --chat-box: var(--el-bg-color-overlay);
  --chat-card: var(--el-fill-color-light);
  --chat-highlight: var(--el-color-primary-light-3);
  --chat-highlight-card: var(--el-fill-color);
  --chat-box-shadow: var(--el-box-shadow-light);
  --chat-rect-padding: 0px;
}

:global(.textNodeMentions) {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

:global(.textNodeMentions .chat-dialog-wrap .chat-mention-dialog-wrap.chat-view-show) {
  animation: none;
}

:global(.textNodeMentions .chat-dialog-wrap .groupedMentions) {
  width: min(1040px, calc(100vw - 32px));
  box-sizing: border-box;
  padding: 12px;
  border-radius: 12px;
}

:global(.textNodeMentions .groupedMentions .chat-mention-dialog-main) { display: none; }

.referenceColumns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  max-height: min(460px, 60vh);
  overflow: auto;
  .referenceColumn {
    min-width: 0;
    h4 {
      display: flex; justify-content: space-between; margin: 0 0 6px; padding: 6px;
      color: var(--el-text-color-primary); font-size: 13px; border-bottom: 1px solid var(--el-border-color-lighter);
      span { color: var(--el-text-color-secondary); font-weight: normal; }
    }
    .referenceOptions {
      max-height: 260px; overflow-y: auto;
      .referenceOption {
        display: flex; align-items: center; gap: 8px; width: 100%; min-height: 48px; padding: 6px;
        border: 0; border-radius: 6px; background: transparent; color: var(--el-text-color-primary); text-align: left; cursor: pointer;
        &:hover, &.active { background: var(--el-fill-color); color: var(--el-color-primary); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
        img { width: 32px; height: 32px; flex-shrink: 0; object-fit: cover; border-radius: 4px; }
        > span {
          display: grid; gap: 3px; min-width: 0;
          strong, small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          strong { font-size: 12px; font-weight: 500; }
          small { color: var(--el-text-color-secondary); font-size: 10px; }
        }
      }
    }
  }
}

.promptInput {
  display: block;
  cursor: text;
  -webkit-user-select: text;
  user-select: text;

  &.expandedInput {
    height: 100%;
    margin: 0;
  }

  &:deep(.imageReference) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0 3px;
    padding: 2px 6px 2px 2px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--el-border-radius-base);
    background: var(--el-fill-color-light);
    color: var(--el-text-color-primary);
    font-size: 12px;
    line-height: 18px;
    white-space: nowrap;
    vertical-align: middle;

    &:has(img) {
      cursor: zoom-in;
    }

    img {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      object-fit: cover;
      border-radius: 3px;
      pointer-events: none;
    }
  }

  &:deep(.chat-placeholder-wrap) {
    font-style: normal;
  }
}
</style>
