const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// === 1. 读取本地 JSON 配置文件 ===
let config = {};
try {
    const configPath = path.join(__dirname, 'server_config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
    console.error('❌ 无法读取配置文件 server_config.json:', err.message);
    process.exit(1);
}

const PORT = config.PORT || 3000;
const SECRET_KEY = config.SECRET_KEY;
const ALERT_ENABLED = config.ALERT_ENABLED || false;

// 存储服务器数据与告警历史
let vpsData = {};
let alertHistory = {}; // 格式: { "HK-01": 1711234567890 }

// === 2. ntfy 专用告警发送函数 (纯原生 https) ===
function sendNtfyAlert(vpsId, reason) {
    if (!ALERT_ENABLED || !config.NTFY_SERVER || !config.NTFY_TOPIC) return;

    console.log(`[ntfy 告警触发] 正在为 ${vpsId} 发送通知...`);

    const title = `🚨 VPS 离线告警: ${vpsId}`;
    const base64Title = Buffer.from(title).toString('base64');
    const bodyText = `节点名称: ${vpsId}\n触发原因: ${reason}\n\n※ 24小时内同节点仅通知一次。`;

    try {
        // 拼接完整的请求路径
        const targetUrl = new URL(`${config.NTFY_SERVER}/${config.NTFY_TOPIC}`);
        
        // 根据配置自动选择是用 http 还是 https 模块
        const httpModule = targetUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'X-Title': title,//`base64:${base64Title}`, // 使用 base64 编码防止中文标题在 header 中乱码
                //'X-Title-Encoding': 'base64',
                'X-Priority': '5', // 5 = Max 紧急程度（在手机端会发出强警报并置顶）
                'X-Tags': 'warning,computer'
            }
        };

        const req = httpModule.request(options, (res) => {
            res.on('data', () => {}); // 消耗响应流
        });

        req.on('error', (e) => console.error('ntfy 发送错误:', e.message));
        req.write(bodyText);
        req.end();
    } catch (e) {
        console.error('解析 ntfy URL 失败:', e.message);
    }
}

// === 3. 定时轮询：每 10 秒扫描一次所有 VPS 的在线状态 ===
setInterval(() => {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    Object.keys(vpsData).forEach(id => {
        const node = vpsData[id];
        const isOnline = (now - node.lastSeen) < 15000;

        if (!isOnline) {
            const lastAlertTime = alertHistory[id] || 0;
            
            // 24 小时内已经告警过则拦截
            if (now - lastAlertTime < TWENTY_FOUR_HOURS) {
                return; 
            }

            alertHistory[id] = now;
            sendNtfyAlert(id, `主控端超过 15 秒未收到心跳包，可能已宕机或网络中断。`);
        }
    });
}, 10000);

// === 4. HTTP 服务器逻辑 ===
const htmlPage = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8"><title>原生 Node.js VPS 看板</title>
    <style>
        body { font-family: -apple-system, sans-serif; background: #f4f6f9; margin: 20px; }
        h1 { color: #333; text-align: center; }
        .container { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; max-width: 1200px; margin: 0 auto; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); position: relative; }
        .badge { position: absolute; top: 20px; right: 20px; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
        .online { background: #e6fffa; color: #234e52; } .offline { background: #fff5f5; color: #9b2c2c; }
        .vps-id { font-size: 20px; font-weight: bold; margin-bottom: 15px; color: #2d3748; }
        .stat-item { margin: 8px 0; font-size: 14px; color: #4a5568; }
        .progress-bar { background: #edf2f7; border-radius: 4px; height: 8px; overflow: hidden; margin-top: 4px; }
        .progress { background: #48bb78; height: 100%; transition: width 0.5s; }
        .high { background: #f56565; } .custom-dir { margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e2e8f0; }
    </style>
</head>
<body>
    <h1>🛸 原生 Node.js 集中看板</h1><div class="container" id="board">正在同步服务器状态...</div>
    <script>
        async function refresh() {
            try {
                const res = await fetch('/api/status'); const data = await res.json();
                document.getElementById('board').innerHTML = data.length === 0 ? '<p style="text-align:center;width:100%">暂无机器上报数据</p>' : data.map(vps => {
                    let customDirHtml = '';
                    if (vps.customDir) {
                        customDirHtml = vps.customDir.error 
                            ? \`<div class="stat-item custom-dir" style="color:#e53e3e;font-size:12px;">⚠️ 目录未找到或无权限: \${vps.customDir.path}</div>\`
                            : \`<div class="stat-item custom-dir">📁 目录占满度 (\${vps.customDir.path}): \${vps.customDir.pct}% / \${vps.customDir.max}<div class="progress-bar"><div class="progress \${vps.customDir.pct >= 90 ? 'high' : ''}" style="width:\${vps.customDir.pct}%"></div></div></div>\`;
                    }
                    return \`<div class="card"><span class="badge \${vps.online ? 'online' : 'offline'}">\${vps.online ? '在线' : '离线'}</span><div class="vps-id">\${vps.id}</div><div class="stat-item">CPU: \${vps.cpu}%<div class="progress-bar"><div class="progress \${vps.cpu>80?'high':''}" style="width:\${vps.cpu}%"></div></div></div><div class="stat-item">内存: \${vps.mem}%<div class="progress-bar"><div class="progress \${vps.mem>80?'high':''}" style="width:\${vps.mem}%"></div></div></div><div class="stat-item">系统磁盘: \${vps.disk}%<div class="progress-bar"><div class="progress \${vps.disk>90?'high':''}" style="width:\${vps.disk}%"></div></div></div>\${customDirHtml}<div style="margin-top:15px;font-size:12px;color:#a0aec0;">运行: \${vps.uptime}</div></div>\`;
                }).join('');
            } catch (e) { console.error(e); }
        }
        refresh(); setInterval(refresh, 3000);
    </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(htmlPage);
    }
    if (req.method === 'GET' && req.url === '/api/status') {
        const now = Date.now();
        const result = Object.keys(vpsData).map(id => {
            const node = vpsData[id];
            return { id, ...node, online: (now - node.lastSeen) < 15000 };
        });
        result.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
    }
    if (req.method === 'POST' && req.url === '/api/report') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.secret !== SECRET_KEY) { res.writeHead(403); return res.end('Unauthorized'); }
                vpsData[data.id] = { cpu: data.cpu, mem: data.mem, disk: data.disk, uptime: data.uptime, customDir: data.customDir, lastSeen: Date.now() };
                res.writeHead(200); res.end('OK');
            } catch (err) { res.writeHead(400); res.end('Bad Request'); }
        });
        return;
    }
    res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => { console.log(`[看板主控] 服务已启动。ntfy 告警通道就绪。`); });
