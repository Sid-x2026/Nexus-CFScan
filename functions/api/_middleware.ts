interface Env {
    JWT_SECRET: string;
}

/**
 * 这个中间件会拦截所有 /api/* 的请求
 */
export const onRequest: PagesFunction<Env> = async (context) => {
    const { request, env, next } = context;
    const url = new URL(request.url);

    // 公共接口：登录接口不需要鉴权
    if (url.pathname === '/api/login') {
        return await next();
    }

    // 公共接口：订阅拉取不需要鉴权——客户端（V2RayN / 小火箭 / Clash）
    // 没有本站的登录 token，GET /api/sub?id=xxx 必须能直接拉到内容；
    // 生成链接的 POST 仍要鉴权（下面继续检查）。
    if (url.pathname === '/api/sub' && request.method === 'GET') {
        return await next();
    }

    // 受保护的接口：检查 Authorization Header
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response('Unauthorized: Missing or invalid token.', { status: 401 });
    }

    const token = authHeader.substring(7); // 提取 "Bearer " 后面的 token

    if (!env.JWT_SECRET) {
        console.error("FATAL: JWT_SECRET is not configured in environment variables.");
        return new Response('Internal Server Error: Auth is not configured.', { status: 500 });
    }

    // 简单比对 Token 是否等于环境变量中的 JWT_SECRET
    if (token === env.JWT_SECRET) {
        return await next(); // 验证通过，放行请求到具体的接口函数
    } else {
        return new Response('Unauthorized: Invalid or expired token.', { status: 401 });
    }
};