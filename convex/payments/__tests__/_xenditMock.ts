type XenditCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};

const calls: XenditCall[] = [];
let nextResponse: any = null;
let nextStatus = 200;
let throwNext: Error | null = null;

export function _xenditMockReset() {
  calls.length = 0;
  nextResponse = null;
  nextStatus = 200;
  throwNext = null;
}

export function _xenditMockCalls(): XenditCall[] {
  return [...calls];
}

export function _xenditMockNextResponse(r: any, status = 200) {
  nextResponse = r;
  nextStatus = status;
}

export function _xenditMockThrowNext(e: Error) {
  throwNext = e;
}

// Install global fetch mock — call from beforeEach in tests
export function installFetchMock() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : (url as URL).toString();
    if (!urlStr.includes("xendit")) return realFetch(url as any, init);
    if (throwNext) {
      const e = throwNext; throwNext = null; throw e;
    }
    calls.push({
      url: urlStr,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: nextStatus >= 200 && nextStatus < 300,
      status: nextStatus,
      json: async () => nextResponse,
      text: async () => JSON.stringify(nextResponse),
    } as any;
  }) as any;
}
