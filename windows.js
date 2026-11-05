const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const execSync = require('child_process').execSync;

// === 1. 读取本地 JSON 配置文件 ===
let config = {};
try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
} catch (err) {
    console.error('❌ 无法读取配置文件 config.json:', err.message);
    process.exit(1);
}

const SERVER_HOST = config.SERVER_HOST || 'localhost';
const SERVER_PORT = config.SERVER_PORT || 3000;
const SERVER_PATH = config.SERVER_PATH || '/api/report';
const USE_HTTPS = config.USE_HTTPS || false;
const SECRET_KEY = config.SECRET_KEY;
const VPS_ID = config.VPS_ID || 'Win-VPS';
const REPORT_INTERVAL = config.REPORT_INTERVAL || 5000;
const MONITOR_DIR_PATH = config.MONITOR_DIR_PATH || '';
const MONITOR_DIR_MAX_SIZE = config.MONITOR_DIR_MAX_SIZE || '';

const httpClient = USE_HTTPS ? https : http;

// === 2. Windows 专属原生指标采集（基于 PowerShell） ===

// 将大小配置字符串转为 KB
function parseSizeToKB(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.toUpperCase().match(/^(\d+(?:\.\d+)?)\s*([GM])$/);
    if (!match) return 0;
    const num = parseFloat(match);
    const unit = match[2];
    if (unit === 'G') return num * 1024 * 1024;
    if (unit === 'M') return num * 1024;
    return 0;
}

// 获取 Windows 指定目录的占用百分比
function getCustomDirUsage() {
    if (!MONITOR_DIR_PATH || !MONITOR_DIR_MAX_SIZE) return null;
    try {
        // 使用 PowerShell 递归统计指定文件夹下所有文件的大小总和 (Bytes)
        const cmd = `powershell -NoProfile -Command "(Get-ChildItem '${MONITOR_DIR_PATH}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`;
        const output = execSync(cmd).toString().trim();
        const currentBytes = parseInt(output) || 0;
        const currentKB = currentBytes / 1024;
        
        const maxKB = parseSizeToKB(MONITOR_DIR_MAX_SIZE);
        if (maxKB === 0) return null;

        const percentage = Math.round((currentKB / maxKB) * 100);
        return {
            path: MONITOR_DIR_PATH,
            max: MONITOR_DIR_MAX_SIZE,
            pct: percentage > 100 ? 100 : percentage
        };
    } catch (e) {
        return { path: MONITOR_DIR_PATH, max: MONITOR_DIR_MAX_SIZE, error: true };
    }
}

// 通过 WMI 获取 Windows 瞬时 CPU 使用率
function getCpuUsage() {
    try {
        const cmd = `powershell -NoProfile -Command "(Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"`;
        const output = execSync(cmd).toString().trim();
        return Math.round(parseFloat(output)) || 0;
    } catch (e) {
        return 0;
    }
}

// 获取 Windows 内存使用率
function getMemUsage() {
    try {
        // 获取总物理内存与当前可用物理内存 (KB)
        const cmd = `powershell -NoProfile -Command "$os = Get-WmiObject Win32_OperatingSystem; [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100)"`;
        const output = execSync(cmd).toString().trim();
        return parseInt(output) || 0;
    } catch (e) {
        return 0;
    }
}

// 获取 Windows C 盘整体磁盘使用率
function getDiskUsage() {
    try {
        const cmd = `powershell -NoProfile -Command "$disk = Get-WmiObject Win32_LogicalDisk -Filter \\"DeviceID='C:'\\"; [math]::Round((($disk.Size - $disk.FreeSpace) / $disk.Size) * 100)"`;
        const output = execSync(cmd).toString().trim();
        return parseInt(output) || 0;
    } catch (e) {
        return 0;
    }
}

// 获取 Windows 系统运行时间（通过 PowerShell 强制在管道输出中应用 UTF-8 编码，不改动服务端）
function getUptime() {
    try {
        // [Console]::OutputEncoding 强制将终端运行时输出设置为 UTF-8 字符集
        const cmd = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime; '{0}天 {1}时 {2}分' -f $uptime.Days, $uptime.Hours, $uptime.Minutes"`;
        const output = execSync(cmd).toString('utf8').trim(); // 显式用 utf8 接收字节流
        return output || '未知';
    } catch (e) {
        try {
            const backupCmd = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $os = Get-WmiObject Win32_OperatingSystem; $uptime = (Get-Date) - $os.ConvertToDateTime($os.LastBootUpTime); '{0}天 {1}时 {2}分' -f $uptime.Days, $uptime.Hours, $uptime.Minutes"`;
            return execSync(backupCmd).toString('utf8').trim();
        } catch (err) {
            return '未知';
        }
    }
}

// === 3. 数据定时上报逻辑 ===
function doReport() {
    const payload = JSON.stringify({
        secret: SECRET_KEY,
        id: VPS_ID,
        cpu: getCpuUsage(),
        mem: getMemUsage(),
        disk: getDiskUsage(),
        uptime: getUptime(),
        customDir: getCustomDirUsage()
    });

    const options = {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: SERVER_PATH,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = httpClient.request(options, (res) => {
        res.on('data', () => {}); 
    });
    
    req.on('error', (err) => {
        console.error(`[${VPS_ID}] 上报失败: ${err.message}`);
    });
    
    req.write(payload);
    req.end();
}

// 启动循环轮询
console.log(`[${VPS_ID}] Windows 原生 Agent 已启动，正在上报至 ${SERVER_HOST}...`);
doReport();
setInterval(doReport, REPORT_INTERVAL);
