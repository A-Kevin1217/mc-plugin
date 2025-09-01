import { WebSocketServer, WebSocket } from 'ws';
import Config from './Config.js';
import processAndSend from './SendMsg.js';

const WS_LOG_PREFIX = logger.blue('[Minecraft WebSocket] ');

// 连接状态常量
const CONNECTION_STATES = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting', 
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    FAILED: 'failed'
};

class WebSocketManager {

    constructor() {
        this.activeSockets = {};
        this.connectionStates = {}; // 连接状态跟踪
        this.reconnectTimers = {}; // 重连定时器跟踪
        this.reconnectAttempts = {}; // 重连尝试次数跟踪
        this.lastPingTime = {}; // 最后ping时间
        this._initializeAsync();
        this._startHeartbeatMonitor();
    }

    async _initializeAsync() {
        try {
            const config = Config.getConfig();
            if (!config) {
                logger.error(WS_LOG_PREFIX + '无法获取配置，WebSocket服务无法启动');
                return;
            }

            if (config.mc_qq_ws_server) {
                this._startLocalServer(config);
            }

            this._connectToRemoteServers(config);

        } catch (error) {
            logger.error(WS_LOG_PREFIX + `初始化失败: ${error.message}`);
        }
    }

    _startLocalServer(config) {
        const { mc_qq_ws_port: wsPort, mc_qq_ws_url: wsPath, mc_qq_ws_password: wsPassword, debug_mode: debugMode } = config;

        if (!wsPort || !wsPath) {
            logger.error(WS_LOG_PREFIX + 'WebSocket服务器端口或路径未配置，无法启动');
            return;
        }

        const wss = new WebSocketServer({ port: wsPort, path: wsPath });

        wss.on('listening', () => {
            logger.mark(
                WS_LOG_PREFIX +
                '监听地址：' +
                logger.green(`ws://localhost:${wsPort}${wsPath}`)
            );
        });

        wss.on('connection', (ws, request) => {
            let remoteName
            try {
                remoteName = decodeURIComponent(request.headers['x-self-name']);
                let authToken = decodeURIComponent(request.headers['authorization']);
                authToken = authToken.replace(/^Bearer\s*/i, '');

                if (!remoteName) {
                    ws.close(1008, 'Invalid remote name');
                    return;
                }

                if (wsPassword && authToken !== wsPassword) {
                    ws.close(1008, 'Invalid token');
                    logger.mark(
                        WS_LOG_PREFIX +
                        logger.yellow(remoteName) +
                        ' 尝试连接，但令牌无效，已拒绝'
                    );
                    return;
                }

                if (this.activeSockets[remoteName]) {
                    ws.close(1000, 'Duplicate connection');
                    logger.mark(
                        WS_LOG_PREFIX +
                        logger.yellow(remoteName) +
                        ' 尝试连接，但已存在同名连接，已拒绝'
                    );
                    return;
                }

                logger.mark(WS_LOG_PREFIX + logger.green(remoteName) + ' 已连接');
                this.activeSockets[remoteName] = ws;

                ws.on('message', (message) => {
                    if (debugMode) {
                        logger.mark(
                            WS_LOG_PREFIX +
                            logger.green(remoteName) +
                            ' 收到消息：' + message
                        );
                    }
                    processAndSend(message.toString());
                });

                ws.on('close', (code, reason) => {
                    logger.mark(
                        WS_LOG_PREFIX +
                        logger.yellow(remoteName) +
                        ` 已断开 Code: ${code}, Reason: ${reason || 'N/A'}`
                    );
                    delete this.activeSockets[remoteName];
                });

                ws.on('error', (error) => {
                    logger.error(
                        WS_LOG_PREFIX +
                        logger.red(remoteName) +
                        ` 连接出错 ${error.message}`
                    );
                    delete this.activeSockets[remoteName];
                });

            } catch (error) {
                logger.error(WS_LOG_PREFIX + `处理来自 ${remoteName ? logger.red(remoteName) : '未知服务器'} 的新连接时出错: ${error.message}`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1011, 'Internal server error');
                }
            }
        });

        wss.on('error', (error) => {
            logger.error(WS_LOG_PREFIX + `本地服务器错误: ${error.message}`);
        });
    }

    _connectToRemoteServers(config) {
        const { mc_qq_server_list: remoteServers, debug_mode: debugMode } = config;

        if (!remoteServers || !Array.isArray(remoteServers)) {
            logger.info(WS_LOG_PREFIX + '未配置远程服务器列表或格式不正确');
            return;
        }

        remoteServers.forEach(serverCfg => {
            if (serverCfg.ws_able && serverCfg.ws_url && serverCfg.server_name) {
                if (this.activeSockets[serverCfg.server_name]) {
                    logger.info(WS_LOG_PREFIX + `已存在到 ${serverCfg.server_name} 的连接，跳过`);
                } else {
                    this._establishClientConnection(serverCfg, debugMode);
                }
            } else if (serverCfg.ws_able) {
                logger.warn(WS_LOG_PREFIX + `远程服务器配置 ${serverCfg.server_name || '未命名'} 不完整，跳过`);
            }
        });
    }

    /**
     * 设置连接状态
     */
    _setConnectionState(serverName, state) {
        this.connectionStates[serverName] = state;
    }

    /**
     * 获取连接状态
     */
    _getConnectionState(serverName) {
        return this.connectionStates[serverName] || CONNECTION_STATES.DISCONNECTED;
    }

    /**
     * 清理连接相关资源
     */
    _cleanupConnection(serverName) {
        if (this.activeSockets[serverName]) {
            const ws = this.activeSockets[serverName];
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
            delete this.activeSockets[serverName];
        }
        if (this.reconnectTimers[serverName]) {
            clearTimeout(this.reconnectTimers[serverName]);
            delete this.reconnectTimers[serverName];
        }
    }

    /**
     * 计算重连延迟（指数退避）
     */
    _calculateReconnectDelay(attempts) {
        const baseDelay = 5000; // 基础延迟5秒
        const maxDelay = 300000; // 最大延迟5分钟
        const delay = Math.min(baseDelay * Math.pow(2, Math.min(attempts, 6)), maxDelay);
        return delay;
    }

    /**
     * 安排重连
     */
    _scheduleReconnect(serverCfg, globalDebug) {
        const serverName = serverCfg.server_name;
        
        // 防止重复重连
        if (this.reconnectTimers[serverName] || 
            this._getConnectionState(serverName) === CONNECTION_STATES.CONNECTING ||
            this._getConnectionState(serverName) === CONNECTION_STATES.RECONNECTING) {
            return;
        }

        if (!serverCfg.ws_able) {
            logger.info(WS_LOG_PREFIX + `${serverName} WebSocket已禁用，停止重连`);
            return;
        }

        const attempts = (this.reconnectAttempts[serverName] || 0) + 1;
        this.reconnectAttempts[serverName] = attempts;
        
        const delay = this._calculateReconnectDelay(attempts);
        const maxAttempts = serverCfg.ws_max_attempts || 3;
        
        // 短期重连（有限次数）和长期重连（无限次数，更长间隔）
        if (attempts <= maxAttempts) {
            logger.info(WS_LOG_PREFIX + `${serverName} 将在 ${delay/1000} 秒后尝试重新连接... (尝试次数: ${attempts}/${maxAttempts})`);
        } else {
            // 长期重连，每5分钟尝试一次
            const longTermDelay = 300000; // 5分钟
            logger.info(WS_LOG_PREFIX + `${serverName} 进入长期重连模式，将在 ${longTermDelay/1000} 秒后重试...`);
            
            this.reconnectTimers[serverName] = setTimeout(() => {
                this._attemptReconnect(serverCfg, globalDebug);
            }, longTermDelay);
            return;
        }

        this._setConnectionState(serverName, CONNECTION_STATES.RECONNECTING);
        this.reconnectTimers[serverName] = setTimeout(() => {
            this._attemptReconnect(serverCfg, globalDebug);
        }, delay);
    }

    /**
     * 尝试重连
     */
    async _attemptReconnect(serverCfg, globalDebug) {
        const serverName = serverCfg.server_name;
        delete this.reconnectTimers[serverName];
        
        if (!serverCfg.ws_able) {
            logger.info(WS_LOG_PREFIX + `${serverName} WebSocket已禁用，取消重连`);
            this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
            return;
        }

        await this._establishClientConnection(serverCfg, globalDebug, true);
    }

    async _establishClientConnection(serverCfg, globalDebug, isReconnect = false) {
        const { server_name: serverName, ws_url: serverUrl, ws_password: serverToken } = serverCfg;

        // 防止重复连接
        const currentState = this._getConnectionState(serverName);
        if (currentState === CONNECTION_STATES.CONNECTING || currentState === CONNECTION_STATES.CONNECTED) {
            return;
        }

        this._setConnectionState(serverName, CONNECTION_STATES.CONNECTING);
        
        if (!isReconnect) {
            this.reconnectAttempts[serverName] = 0;
        }

        logger.info(WS_LOG_PREFIX + `尝试连接到 ${serverName} (${serverUrl})...`);

        const headers = {
            'X-Self-Name': encodeURIComponent(serverName),
            'Authorization': serverToken ? `Bearer ${encodeURIComponent(serverToken)}` : undefined
        };
        Object.keys(headers).forEach(key => headers[key] === undefined && delete headers[key]);

        try {
            const ws = new WebSocket(serverUrl, { headers });

            ws.on('open', () => {
                logger.mark(WS_LOG_PREFIX + logger.green(serverName) + ' WebSocket连接成功');
                
                // 连接成功，重置重连计数
                this.activeSockets[serverName] = ws;
                this.reconnectAttempts[serverName] = 0;
                this._setConnectionState(serverName, CONNECTION_STATES.CONNECTED);
            });

            ws.on('message', (message) => {
                if (globalDebug) {
                    logger.mark(
                        WS_LOG_PREFIX +
                        logger.green(serverName) +
                        ' 收到消息：' +
                        logger.green(message.toString())
                    );
                }
                processAndSend(message.toString());
            });

            ws.on('close', (code, reason) => {
                logger.mark(
                    WS_LOG_PREFIX +
                    logger.yellow(serverName) +
                    ` WebSocket连接已断开 Code: ${code}, Reason: ${reason || 'N/A'}`
                );
                this._cleanupConnection(serverName);
                this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
                
                // 只有非主动关闭的情况才重连
                if (code !== 1000) { // 1000 = 正常关闭
                    this._scheduleReconnect(serverCfg, globalDebug);
                }
            });

            ws.on('error', (error) => {
                logger.error(
                    WS_LOG_PREFIX +
                    logger.red(serverName) +
                    ` WebSocket连接错误: ${error.message}`
                );
                this._cleanupConnection(serverName);
                this._setConnectionState(serverName, CONNECTION_STATES.FAILED);
                this._scheduleReconnect(serverCfg, globalDebug);
            });

        } catch (error) {
            logger.warn(WS_LOG_PREFIX + logger.red(serverName) + ` WebSocket连接失败: ${error.message}`);
            this._cleanupConnection(serverName);
            this._setConnectionState(serverName, CONNECTION_STATES.FAILED);
            this._scheduleReconnect(serverCfg, globalDebug);
        }
    }

    /**
     * 手动重连指定服务器
     */
    async forceReconnect(serverName) {
        const config = Config.getConfig();
        const serverCfg = config.mc_qq_server_list?.find(s => s.server_name === serverName);
        
        if (!serverCfg) {
            logger.error(WS_LOG_PREFIX + `未找到服务器配置: ${serverName}`);
            return false;
        }

        if (!serverCfg.ws_able) {
            logger.info(WS_LOG_PREFIX + `${serverName} WebSocket已禁用`);
            return false;
        }

        logger.info(WS_LOG_PREFIX + `手动重连 ${serverName}...`);
        
        // 清理现有连接和定时器
        this._cleanupConnection(serverName);
        this.reconnectAttempts[serverName] = 0;
        
        const globalDebug = config.debug_mode;
        await this._establishClientConnection(serverCfg, globalDebug, false);
        return true;
    }

    /**
     * 获取连接状态信息
     */
    getConnectionStatus() {
        const status = {};
        const config = Config.getConfig();
        const serverList = config.mc_qq_server_list || [];
        
        serverList.forEach(serverCfg => {
            if (serverCfg.ws_able) {
                const serverName = serverCfg.server_name;
                status[serverName] = {
                    state: this._getConnectionState(serverName),
                    connected: !!this.activeSockets[serverName],
                    reconnectAttempts: this.reconnectAttempts[serverName] || 0,
                    hasReconnectTimer: !!this.reconnectTimers[serverName]
                };
            }
        });
        
        return status;
    }

    /**
     * 启动心跳监控
     */
    _startHeartbeatMonitor() {
        // 每45秒检查一次所有WebSocket连接
        setInterval(() => {
            this._performHeartbeatCheck();
        }, 45000);
    }

    /**
     * 执行WebSocket心跳检查
     */
    _performHeartbeatCheck() {
        const config = Config.getConfig();
        if (!config?.mc_qq_server_list) return;

        for (const [serverName, ws] of Object.entries(this.activeSockets)) {
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    // 发送ping frame
                    this.lastPingTime[serverName] = Date.now();
                    
                    // 设置pong超时检查
                    const timeoutId = setTimeout(() => {
                        logger.warn(WS_LOG_PREFIX + `${serverName} WebSocket心跳超时，可能连接已死`);
                        
                        const serverCfg = config.mc_qq_server_list.find(s => s.server_name === serverName);
                        if (serverCfg) {
                            this._cleanupConnection(serverName);
                            this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
                            this._scheduleReconnect(serverCfg, config.debug_mode);
                        }
                    }, 15000); // 15秒超时

                    // 监听pong响应
                    const onPong = () => {
                        clearTimeout(timeoutId);
                        const responseTime = Date.now() - this.lastPingTime[serverName];
                        if (responseTime > 10000) {
                            logger.warn(WS_LOG_PREFIX + `${serverName} WebSocket心跳响应缓慢 (${responseTime}ms)`);
                        }
                        ws.off('pong', onPong);
                    };

                    ws.on('pong', onPong);
                    ws.ping();
                } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                    // 连接已关闭，清理并重连
                    const serverCfg = config.mc_qq_server_list.find(s => s.server_name === serverName);
                    if (serverCfg) {
                        this._cleanupConnection(serverName);
                        this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
                        this._scheduleReconnect(serverCfg, config.debug_mode);
                    }
                }
            } catch (error) {
                logger.warn(WS_LOG_PREFIX + `${serverName} WebSocket心跳检查失败: ${error.message}`);
                
                const serverCfg = config.mc_qq_server_list.find(s => s.server_name === serverName);
                if (serverCfg) {
                    this._cleanupConnection(serverName);
                    this._setConnectionState(serverName, CONNECTION_STATES.DISCONNECTED);
                    this._scheduleReconnect(serverCfg, config.debug_mode);
                }
            }
        }
    }
}

export default new WebSocketManager();