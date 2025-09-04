// A single-file, self-contained, authenticated Cloud Drive on Cloudflare Workers and R2
// Features: Login, Logout, File Listing, Preview, Download, Upload, Delete
// Public users can list, preview, and download.
// Logged-in admin can also upload and delete.

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // Check if the user is logged in by verifying the cookie
        const isLoggedIn = await checkAuth(request, env);

        // Routing
        if (path === "/" && method === "GET") {
            return handleListPage(env, isLoggedIn);
        }
        if (path === "/login" && method === "GET") {
            return handleLoginPage();
        }
        if (path === "/login" && method === "POST") {
            return handleLoginPost(request, env);
        }
        if (path === "/logout" && method === "GET") {
            return handleLogout();
        }
        if (path === "/upload" && method === "POST") {
            if (!isLoggedIn) return new Response("Forbidden", { status: 403 });
            return handleUpload(request, env);
        }
        if (path.startsWith("/delete/") && method === "POST") {
            if (!isLoggedIn) return new Response("Forbidden", { status: 403 });
            const key = decodeURIComponent(path.replace("/delete/", ""));
            return handleDelete(env, key);
        }
        if (path.startsWith("/preview/")) {
            const key = decodeURIComponent(path.replace("/preview/", ""));
            return handleFile(env, key, "inline");
        }
        if (path.startsWith("/download/")) {
            const key = decodeURIComponent(path.replace("/download/", ""));
            return handleFile(env, key, "attachment");
        }

        return new Response("404 Not Found", { status: 404 });
    },
};

// --- Authentication Handlers ---

const AUTH_COOKIE_NAME = "__my_drive_auth";

async function checkAuth(request, env) {
    const cookie = request.headers.get("Cookie");
    if (!cookie) return false;

    const match = cookie.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
    if (!match) return false;

    const [value, iv, salt] = match[1].split('.');
    if (!value || !iv || !salt) return false;

    const secretKey = await createKey(env.COOKIE_SECRET, salt);

    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: hexToBytes(iv) },
            secretKey,
            hexToBytes(value)
        );
        const decodedValue = new TextDecoder().decode(decrypted);
        return decodedValue === env.ADMIN_USERNAME;
    } catch (e) {
        return false;
    }
}

async function handleLoginPost(request, env) {
    const formData = await request.formData();
    const username = formData.get("username");
    const password = formData.get("password");

    if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
        const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const secretKey = await createKey(env.COOKIE_SECRET, salt);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            secretKey,
            new TextEncoder().encode(username)
        );

        const cookieValue = `${bytesToHex(new Uint8Array(encrypted))}.${bytesToHex(iv)}.${salt}`;

        const headers = new Headers();
        headers.set("Set-Cookie", `${AUTH_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`); // 1 day expiry
        headers.set("Location", "/");
        return new Response(null, { status: 302, headers });
    } else {
        return new Response("Invalid username or password", { status: 401 });
    }
}

function handleLogout() {
    const headers = new Headers();
    headers.set("Set-Cookie", `${AUTH_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    headers.set("Location", "/");
    return new Response(null, { status: 302, headers });
}

// --- File Operation Handlers ---

async function handleListPage(env, isLoggedIn) {
    const list = await env.MY_BUCKET.list();
    const files = list.objects.map(obj => ({
        key: obj.key,
        size: formatBytes(obj.size),
        uploaded: obj.uploaded.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    }));
    return new Response(generateHTML(files, isLoggedIn), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
}

async function handleUpload(request, env) {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !file.name || file.size === 0) {
        return new Response("No file uploaded or file is empty.", { status: 400 });
    }

    await env.MY_BUCKET.put(file.name, file.stream(), {
        httpMetadata: { contentType: file.type },
    });

    return Response.redirect(request.headers.get("Referer") || "/", 302);
}

async function handleDelete(env, key) {
    if (!key) return new Response("File not specified.", { status: 400 });
    await env.MY_BUCKET.delete(key);
    // Redirect back to the main page after deletion
    return new Response(null, { status: 302, headers: { 'Location': '/' } });
}

async function handleFile(env, key, disposition) {
    if (!key) return new Response("File not specified.", { status: 400 });

    const object = await env.MY_BUCKET.get(key);
    if (object === null) return new Response("Object Not Found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Content-Disposition", `${disposition}; filename="${encodeURIComponent(key)}"`);

    return new Response(object.body, { headers });
}


// --- HTML Generation ---

function generateHTML(files, isLoggedIn) {
    const fileRows = files.map(file => `
        <tr>
            <td class="file-name">${escapeHtml(file.key)}</td>
            <td>${file.size}</td>
            <td>${file.uploaded}</td>
            <td class="actions">
                <a href="/preview/${encodeURIComponent(file.key)}" target="_blank" class="button preview">预览</a>
                <a href="/download/${encodeURIComponent(file.key)}" class="button download">下载</a>
                ${isLoggedIn ? `
                <form action="/delete/${encodeURIComponent(file.key)}" method="post" onsubmit="return confirm('确定要删除这个文件吗？');">
                    <button type="submit" class="button delete">删除</button>
                </form>
                ` : ''}
            </td>
        </tr>
    `).join('');

    const adminSection = isLoggedIn ? `
        <div class="admin-panel">
            <h2>管理员操作</h2>
            <form action="/upload" method="post" enctype="multipart/form-data" id="uploadForm">
                <input type="file" name="file" id="fileInput" required>
                <button type="submit">上传文件</button>
            </form>
            <a href="/logout" class="button logout">退出登录</a>
        </div>
    ` : '<a href="/login" class="button login">管理员登录</a>';

    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cloud Drive</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background-color: #f4f7f9; color: #333; }
            .container { max-width: 960px; margin: 2rem auto; padding: 2rem; background-color: #fff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            h1 { color: #1a2a4c; border-bottom: 2px solid #eef; padding-bottom: 10px; }
            .admin-panel { background: #f8f9fa; padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem; border: 1px solid #dee2e6; }
            .admin-panel h2 { margin-top: 0; }
            #uploadForm { display: flex; align-items: center; gap: 1rem; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #ddd; }
            th { background-color: #f8f8f8; font-weight: 600; color: #495057; }
            tr:hover { background-color: #f1f1f1; }
            .file-name { font-weight: 500; word-break: break-all; }
            .actions { display: flex; align-items: center; gap: 0.5rem; }
            .actions form { margin: 0; }
            .button { text-decoration: none; color: white; padding: 8px 14px; border-radius: 5px; font-size: 14px; transition: background-color 0.2s; border: none; cursor: pointer; display: inline-block; }
            .preview { background-color: #007bff; } .preview:hover { background-color: #0056b3; }
            .download { background-color: #28a745; } .download:hover { background-color: #1e7e34; }
            .delete { background-color: #dc3545; font-family: inherit; } .delete:hover { background-color: #c82333; }
            .logout { background-color: #6c757d; } .logout:hover { background-color: #5a6268; }
            .login { background-color: #17a2b8; } .login:hover { background-color: #138496; }
            footer { text-align: center; margin-top: 20px; font-size: 12px; color: #888; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>我的云盘</h1>
            ${adminSection}
            <h2>文件列表</h2>
            ${files.length > 0 ? `
            <table>
                <thead>
                    <tr><th>文件名</th><th>大小</th><th>上传时间</th><th>操作</th></tr>
                </thead>
                <tbody>${fileRows}</tbody>
            </table>` : '<p>这里空空如也，登录后上传第一个文件吧！</p>'}
        </div>
        <footer>Powered by Cloudflare Workers & R2</footer>
    </body>
    </html>
    `;
}

function handleLoginPage() {
    return new Response(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <title>管理员登录</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; background-color: #f4f7f9; }
            form { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 320px; }
            h1 { text-align: center; color: #1a2a4c; }
            label { display: block; margin-bottom: 0.5rem; }
            input { width: 100%; padding: 0.75rem; margin-bottom: 1rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
            button { width: 100%; padding: 0.75rem; background-color: #007bff; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
            button:hover { background-color: #0056b3; }
        </style>
    </head>
    <body>
        <form action="/login" method="post">
            <h1>管理员登录</h1>
            <label for="username">用户名:</label>
            <input type="text" id="username" name="username" required>
            <label for="password">密码:</label>
            <input type="password" id="password" name="password" required>
            <button type="submit">登录</button>
        </form>
    </body>
    </html>
    `, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

// --- Helper Functions ---

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function escapeHtml(unsafe) {
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function createKey(secret, salt) {
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: hexToBytes(salt),
            iterations: 100000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}