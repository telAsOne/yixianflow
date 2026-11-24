import type { Response } from "express";
import { resolve } from "node:path";
import { withFileAccess } from "@/utils/media/objectFiles";
import { sendObjectFile } from "@/utils/media/objectHttp";

export async function sendFile(res: Response, path: string, options: Parameters<Response["sendFile"]>[1] = {}, callback?: (error?: Error) => void) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const req = res.req;
  req.once("aborted", cancel);
  res.once("close", cancel);
  if (req.aborted || res.destroyed) cancel();
  let failure: Error | undefined;
  try {
    let remote=false;
    await withFileAccess([resolve(options.root??"",path)],"read",async()=>{remote=await sendObjectFile(req,res,resolve(options.root??"",path),controller.signal);},controller.signal);
    if(remote){callback?.();return;}
    await withFileAccess([resolve(options.root ?? "", path)], "read", () => new Promise<void>((done, reject) => {
      if (req.aborted || res.destroyed) return done();
      const finish = () => complete();
      const complete = (error?: Error) => {
        res.off("finish", finish);
        res.off("close", finish);
        if (error) reject(error); else done();
      };
      res.once("finish", finish);
      res.once("close", finish);
      try {
        res.sendFile(path, options, error => {
          if (error) complete(error);
          else if (res.writableFinished || res.destroyed) complete();
        });
      } catch (error) { complete(error instanceof Error ? error : new Error(String(error))); }
    }), controller.signal);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    req.off("aborted", cancel);
    res.off("close", cancel);
  }
  if (req.aborted || res.destroyed) return;
  if (callback) callback(failure);
  else if (failure) throw failure;
}
