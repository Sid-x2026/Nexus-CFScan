interface Env {
  IP_KV: KVNamespace;
}

type SubFormat = 'v2ray' | 'clash' | 'singbox';

/**
 * 裂变订阅链接（POST /api/sub 创建，GET /api/sub?id=xxx 拉取）。
 *
 * 为什么要这个接口：裂变订阅是在浏览器本地生成的 base64 / YAML 内容，
 * 没有链接就没法填进客户端的订阅地址栏，二维码也扫不了（内容 3KB+，
 * 二维码根本放不下）。这里把快照存进 KV，返回一条 https 订阅链接，
 * 客户端直接拉取，扫码扫的也是这条链接。
 *
 * - POST 要登录（走 /api/_middleware.ts 的 Bearer 鉴权），GET 公开拉取
 *   （_middleware.ts 对 GET /api/sub 放行，客户端没有 token 也能拉）。
 * - 一个链接只存一种格式的一份快照；裂变后改了节点名，内容变了，
 *   链接还是旧快照，得重新点「生成链接」。
 * - 内容上限 500KB；链接不设过期，删了 KV 里的 key 链接就失效。
 */
function randomId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    const body = (await request.json()) as { format?: string; content?: string };
    const format = body?.format;
    const content = body?.content;
    if (format !== 'v2ray' && format !== 'clash' && format !== 'singbox') {
      return new Response(JSON.stringify({ message: 'format 只能是 v2ray / clash / singbox' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!content || typeof content !== 'string') {
      return new Response(JSON.stringify({ message: '缺少订阅内容' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (content.length > 500 * 1024) {
      return new Response(JSON.stringify({ message: '订阅内容超过 500KB，请减少节点数后重试' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!env.IP_KV) {
      throw new Error('KV 存储未绑定，请检查 Cloudflare Pages 设置 (变量名应为 IP_KV)');
    }
    const id = randomId();
    const value: { format: SubFormat; content: string; createdAt: number } = {
      format: format as SubFormat,
      content,
      createdAt: Date.now(),
    };
    await env.IP_KV.put(`sub:${id}`, JSON.stringify(value));
    return new Response(JSON.stringify({ ok: true, id, url: `/api/sub?id=${id}` }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ message: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id || !/^[a-z0-9]{6,24}$/.test(id)) {
    return new Response('订阅不存在', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  try {
    const raw = await env.IP_KV.get(`sub:${id}`);
    if (!raw) {
      return new Response('订阅不存在或已删除', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const data = JSON.parse(raw) as { format: SubFormat; content: string };
    const contentType =
      data.format === 'clash' ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8';
    return new Response(data.content, {
      headers: {
        'Content-Type': contentType,
        // 链接里的内容是生成时的快照，不会变，客户端可以缓存
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ message: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
