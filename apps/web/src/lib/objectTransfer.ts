import { isAxiosError, type AxiosInstance } from "axios";
import { watch } from "vue";
import { webMode, webUserId } from "./webRuntime";

type TransferSession = {
  upload_id: string;
  upload_url: string;
  expires_at: number;
  headers: Record<string, string>;
  complete: boolean;
  multipart: boolean;
  part_size?: number;
  part_count?: number;
};
type UploadedPart = { part_number: number; etag: string };

function put(
  url: string,
  bytes: Blob,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeout: number,
  progress?: (loaded: number) => void,
): Promise<UploadedPart | undefined> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.timeout = timeout;
    request.withCredentials = false;
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "content-type") {
        reject(new Error("直传参数无效"));
        return;
      }
      request.setRequestHeader(name, value);
    }
    const cancel = () => request.abort();
    const finish = () => signal.removeEventListener("abort", cancel);
    request.upload.onprogress = (event) => progress?.(event.loaded);
    request.onload = () => {
      finish();
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(`素材直传失败（HTTP ${request.status}），请重试原文件`));
        return;
      }
      try {
        resolve(request.responseText ? JSON.parse(request.responseText) : undefined);
      } catch {
        reject(new Error("直传返回内容无效"));
      }
    };
    request.onerror = () => {
      finish();
      reject(new TypeError("直传连接中断"));
    };
    request.ontimeout = () => {
      finish();
      reject(new Error("直传会话已超时"));
    };
    request.onabort = () => {
      finish();
      reject(new DOMException("素材上传已取消", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      finish();
      reject(signal.reason);
      return;
    }
    request.send(bytes);
  });
}

// The authenticated client only sends control JSON. The byte transport has no
// account/API headers and is never replaced by a new generation request.
export async function transferObject(
  client: AxiosInstance,
  base: string,
  input: {
    scope?: "workspace" | "assets";
    directory?: string;
    path: string;
    content: string | Blob | ArrayBuffer;
    exclusive: boolean;
    expectedRevision?: string;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total?: number) => void;
  },
): Promise<boolean> {
  if (!webMode.value || !crypto.subtle) return false;
  const blob = input.content instanceof Blob ? input.content : new Blob([input.content]);
  const media =
    /\.(png|jpe?g|webp|gif|avif|apng|svg|bmp|tiff?|mp4|mkv|mov|webm|avi|m4v|ogv|mp3|wav|ogg|opus|m4a|flac|aac|srt|vtt|pdf|zip|psd|blend|glb|gltf)$/i.test(
      input.path,
    );
  if (
    !blob.size ||
    (input.scope !== "assets" && !/^assets\//.test(input.path.replaceAll("\\", "/")) && !media)
  )
    return false;
  const user = webUserId.value,
    controller = new AbortController();
  const stop = watch(
    webUserId,
    () => controller.abort(new DOMException("账户已切换，上传已取消", "AbortError")),
    { flush: "sync" },
  );
  const signal = input.signal
    ? AbortSignal.any([controller.signal, input.signal])
    : controller.signal;
  let session: TransferSession | undefined;
  try {
    const capabilities = await client.get(base, { signal });
    if (!capabilities.data.data?.direct_upload) return false;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    signal.throwIfAborted();
    const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    const started = await client.post(
      base + "/init",
      {
        directory: input.directory,
        path: input.path,
        size: blob.size,
        sha256,
        idempotencyKey: crypto.randomUUID(),
        exclusive: input.exclusive,
        expectedRevision: input.expectedRevision,
      },
      { signal },
    );
    session = started.data.data as TransferSession;
    const address = new URL(session.upload_url);
    if (address.protocol !== "https:" || address.username || address.password)
      throw new Error("直传地址无效");
    const parts: UploadedPart[] = [];
    if (!session.complete) {
      const size = session.multipart ? session.part_size : blob.size,
        count = session.multipart ? session.part_count : 1;
      if (!size || !count || count !== Math.ceil(blob.size / size))
        throw new Error("直传分片参数无效");
      for (let index = 0; index < count; index++) {
        const start = index * size,
          target = new URL(address);
        if (session.multipart) target.searchParams.set("part_number", String(index + 1));
        const body = blob.slice(start, Math.min(blob.size, start + size));
        let part: UploadedPart | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            part = await put(
              target.href,
              body,
              session.headers,
              signal,
              Math.max(1, session.expires_at * 1000 - Date.now()),
              (loaded) => input.onProgress?.(Math.min(blob.size, start + loaded), blob.size),
            );
            break;
          } catch (error) {
            if (attempt || signal.aborted || !(error instanceof TypeError)) throw error;
          }
        }
        if (session.multipart) {
          if (!part || part.part_number !== index + 1 || !/^[a-f0-9]{32}$/i.test(part.etag))
            throw new Error("分片校验信息无效");
          parts.push(part);
        }
      }
    }
    signal.throwIfAborted();
    for (let attempt = 0; ; attempt++) {
      try {
        await client.post(
          base + "/complete",
          { uploadId: session.upload_id, parts },
          { signal, timeout: 600000 },
        );
        break;
      } catch (error) {
        if (
          attempt >= 2 ||
          signal.aborted ||
          !isAxiosError(error) ||
          (error.response && error.response.status < 500)
        )
          throw error;
      }
    }
    input.onProgress?.(blob.size, blob.size);
    return true;
  } catch (error) {
    if (session && webUserId.value === user)
      void client
        .delete(base + "/cancel", { params: { uploadId: session.upload_id } })
        .catch(() => {});
    throw error;
  } finally {
    stop();
  }
}
