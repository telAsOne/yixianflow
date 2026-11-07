export const whisperModels = ["tiny", "base", "small", "medium", "large", "turbo"] as const;
export type WhisperModel = typeof whisperModels[number];

const gib = 1024 ** 3;
const model = (id: WhisperModel, file: string, sha256: string, bytes: number, ramGiB: number, vramGiB: number) => ({
  id, file, sha256, bytes, ramBytes: ramGiB * gib, vramBytes: vramGiB * gib,
  url: `https://openaipublic.azureedge.net/main/whisper/models/${sha256}/${file}`,
});

// 官方下载表固定摘要；内存预算包含执行余量，不代表实测峰值或速度承诺。
export const whisperCatalog = [
  model("tiny", "tiny.pt", "65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9", 75572083, 1.5, 1),
  model("base", "base.pt", "ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e", 145262807, 2, 1),
  model("small", "small.pt", "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794", 483617219, 3.5, 2),
  model("medium", "medium.pt", "345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1", 1528008539, 6, 5),
  model("large", "large-v3.pt", "e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb", 3087371615, 10, 10),
  model("turbo", "large-v3-turbo.pt", "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a", 1617941637, 6, 6),
];
