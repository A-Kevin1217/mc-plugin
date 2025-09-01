import plugin from '../../../lib/plugins/plugin.js'
import WebSocket from '../components/WebSocket.js'
import RconManager from '../components/Rcon.js'
import Config from '../components/Config.js'

export class Setting extends plugin {
  constructor() {
    super({
      /** 功能名称 */
      name: 'MCQQ-设置同步',
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 1009,
      rule: [
        {
          /** 命令正则匹配 */
          reg: '#?mc(开启|关闭)同步(.*)$',
          /** 执行方法 */
          fnc: 'setting',
          /** 主人权限 */
          permission: 'master'
        },
        {
          /** 命令正则匹配 */
          reg: '#?mc重连$',
          /** 执行方法 */
          fnc: 'reconnect'
        }
      ]
    })
  }

  async setting(e) {

    if (!e.group_id) {
      await e.reply('请在群内使用此功能')
      return true
    }

    const [_, operation, name] = e.msg.match(this.rule[0].reg)
    const server_name = name?.trim()

    if (!server_name) {
      await e.reply('请输入要同步的服务器名称，如 #mc开启同步Server1')
      return true
    }

    const config = Config.getConfig()
    if (!config.mc_qq_server_list.length) {
      await e.reply('请先在配置文件中添加服务器信息')
      return true
    }

    const index = config.mc_qq_server_list.findIndex(s => s.server_name === server_name)
    if (index === -1) {
      await e.reply(`未找到服务器「${server_name}」，发送[#mc状态]查看列表`);
      return true
    }
    const server = config.mc_qq_server_list[index]

    const isEnable = operation === '开启'

    if (isEnable) {
      server.group_list = [...new Set([...(server.group_list || []), e.group_id.toString()])]
      server.bot_self_id = [...new Set([...(server.bot_self_id || []), e.self_id.toString()])]
      server.rcon_able = true
      await e.reply(`✅ 已开启与 ${server_name} 的同步`)
    } else {
      server.group_list = (server.group_list || []).filter(g => g !== e.group_id.toString())
      server.bot_self_id = (server.bot_self_id || []).filter(id => id !== e.self_id.toString())
      server.rcon_able = !!server.group_list.length
      await e.reply(`⛔ 已关闭与 ${server_name} 的同步`)
    }

    Config.setConfig(config);
    return true
  }

  async reconnect(e) {
    await e.reply('🔍 正在检测服务器连接状态...')

    try {
      const config = Config.getConfig()
      const serverList = config.mc_qq_server_list

      if (!serverList || serverList.length === 0) {
        await e.reply('⚠️ 未配置服务器列表')
        return true
      }

      // 首先检测当前连接状态
      const rconStatus = RconManager.getConnectionStatus()
      const wsStatus = WebSocket.getConnectionStatus()

      // 分析哪些服务器需要重连
      const needReconnect = []
      const alreadyConnected = []

      serverList.forEach(serverCfg => {
        const serverName = serverCfg.server_name
        const status = {
          serverName: serverName,
          rconNeedsReconnect: false,
          wsNeedsReconnect: false,
          rconConnected: false,
          wsConnected: false
        }

        // 检查RCON状态
        if (serverCfg.rcon_able) {
          const rconInfo = rconStatus[serverName]
          status.rconConnected = rconInfo?.connected || false
          status.rconNeedsReconnect = !status.rconConnected || 
            rconInfo?.state === 'failed' || 
            rconInfo?.state === 'disconnected'
        }

        // 检查WebSocket状态  
        if (serverCfg.ws_able) {
          const wsInfo = wsStatus[serverName]
          status.wsConnected = wsInfo?.connected || false
          status.wsNeedsReconnect = !status.wsConnected || 
            wsInfo?.state === 'failed' || 
            wsInfo?.state === 'disconnected'
        }

        if (status.rconNeedsReconnect || status.wsNeedsReconnect) {
          needReconnect.push({ serverCfg, status })
        } else {
          alreadyConnected.push({ serverCfg, status })
        }
      })

      // 如果没有服务器需要重连
      if (needReconnect.length === 0) {
        let msg = '✅ 所有服务器连接正常，无需重连！\n\n📊 当前状态：\n'
        
        alreadyConnected.forEach(({ serverCfg, status }) => {
          msg += `\n🏰 ${serverCfg.server_name}：\n`
          if (serverCfg.rcon_able) {
            msg += `├ RCON：✅ 已连接\n`
          }
          if (serverCfg.ws_able) {
            msg += `${serverCfg.rcon_able ? '└' : '├'} WebSocket：✅ 已连接\n`
          }
        })
        
        await e.reply(msg)
        return true
      }

      // 报告检测结果并开始重连
      const totalCount = serverList.length
      const reconnectCount = needReconnect.length
      
      await e.reply(`📊 检测完成！\n✅ 正常连接：${totalCount - reconnectCount} 个\n🔄 需要重连：${reconnectCount} 个\n\n开始重连...`)

      let reconnectResults = []

      // 只重连需要重连的服务器
      const reconnectPromises = needReconnect.map(async ({ serverCfg, status }) => {
        const serverName = serverCfg.server_name
        const results = {
          serverName: serverName,
          rcon: false,
          websocket: false,
          rconAttempted: false,
          wsAttempted: false
        }

        // 重连RCON（仅当需要时）
        if (serverCfg.rcon_able && status.rconNeedsReconnect) {
          results.rconAttempted = true
          try {
            results.rcon = await RconManager.forceReconnect(serverName)
          } catch (error) {
            logger.error(`RCON重连失败 ${serverName}: ${error.message}`)
            results.rcon = false
          }
        } else if (serverCfg.rcon_able) {
          results.rcon = true // 已经连接，无需重连
        }

        // 重连WebSocket（仅当需要时）
        if (serverCfg.ws_able && status.wsNeedsReconnect) {
          results.wsAttempted = true
          try {
            results.websocket = await WebSocket.forceReconnect(serverName)
          } catch (error) {
            logger.error(`WebSocket重连失败 ${serverName}: ${error.message}`)
            results.websocket = false
          }
        } else if (serverCfg.ws_able) {
          results.websocket = true // 已经连接，无需重连
        }

        return results
      })

      reconnectResults = await Promise.all(reconnectPromises)
      
      // 等待连接建立完成
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      // 获取最新连接状态
      const finalRconStatus = RconManager.getConnectionStatus()
      const finalWsStatus = WebSocket.getConnectionStatus()

      let msg = `🔄 智能重连完成！\n\n📊 最终状态详情：\n`

      // 显示所有服务器的状态（包括未重连的）
      serverList.forEach((serverCfg) => {
        const serverName = serverCfg.server_name
        const reconnectResult = reconnectResults.find(r => r.serverName === serverName)
        
        msg += `\n🏰 ${serverName}：\n`
        
        // WebSocket状态
        if (serverCfg.ws_able) {
          const wsInfo = finalWsStatus[serverName]
          const wsState = wsInfo ? this._getStateEmoji(wsInfo.state) : '❌'
          let wsStatus = `${wsState} ${wsInfo?.connected ? '已连接' : '未连接'}`
          
          if (reconnectResult?.wsAttempted) {
            wsStatus += reconnectResult.websocket ? ' 🔄重连成功' : ' ❌重连失败'
          } else if (wsInfo?.connected) {
            wsStatus += ' ✅无需重连'
          }
          
          msg += `├ WebSocket：${wsStatus}\n`
        } else {
          msg += `├ WebSocket：⚪ 已禁用\n`
        }
        
        // RCON状态
        if (serverCfg.rcon_able) {
          const rconInfo = finalRconStatus[serverName]
          const rconState = rconInfo ? this._getStateEmoji(rconInfo.state) : '❌'
          let rconStatus = `${rconState} ${rconInfo?.connected ? '已连接' : '未连接'}`
          
          if (reconnectResult?.rconAttempted) {
            rconStatus += reconnectResult.rcon ? ' 🔄重连成功' : ' ❌重连失败'
          } else if (rconInfo?.connected) {
            rconStatus += ' ✅无需重连'
          }
          
          msg += `└ RCON：${rconStatus}\n`
        } else {
          msg += `└ RCON：⚪ 已禁用\n`
        }
      })

      // 添加智能重连统计
      const attemptedRcon = reconnectResults.filter(r => r.rconAttempted).length
      const successfulRcon = reconnectResults.filter(r => r.rcon && r.rconAttempted).length
      const attemptedWs = reconnectResults.filter(r => r.wsAttempted).length  
      const successfulWs = reconnectResults.filter(r => r.websocket && r.wsAttempted).length
      
      msg += `\n📈 重连统计：\n`
      msg += `• 总服务器：${serverList.length} 个\n`
      msg += `• 需要重连：${needReconnect.length} 个\n`
      if (attemptedRcon > 0) {
        msg += `• RCON重连：${successfulRcon}/${attemptedRcon} 成功\n`
      }
      if (attemptedWs > 0) {
        msg += `• WebSocket重连：${successfulWs}/${attemptedWs} 成功`
      }

      await e.reply(msg)
    } catch (error) {
      logger.error('重连失败：', error)
      await e.reply('❌ 重连过程中出现错误，请查看日志')
    }

    return true
  }

  /**
   * 获取连接状态表情符号
   */
  _getStateEmoji(state) {
    switch (state) {
      case 'connected': return '✅'
      case 'connecting': return '🔄'
      case 'reconnecting': return '🔄'
      case 'failed': return '❌'
      case 'disconnected': return '💤'
      default: return '❓'
    }
  }
}
