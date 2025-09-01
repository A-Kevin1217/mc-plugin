import plugin from '../../../lib/plugins/plugin.js'
import WebSocket from '../components/WebSocket.js'
import RconManager from '../components/Rcon.js'
import Config from '../components/Config.js'

export class Status extends plugin {
  constructor() {
    super({
      /** 功能名称 */
      name: 'MCQQ-连接状态',
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 1009,
      rule: [
        {
          /** 命令正则匹配 */
          reg: '#?mc状态$',
          /** 执行方法 */
          fnc: 'status',
        }
      ]
    })
  }

  async status(e) {
    try {
      const config = Config.getConfig()
      const serverList = config.mc_qq_server_list

      if (!serverList || serverList.length === 0) {
        await e.reply('⚠️ 未配置服务器列表')
        return true
      }

      // 获取详细连接状态
      const rconStatus = RconManager.getConnectionStatus()
      const wsStatus = WebSocket.getConnectionStatus()

      let msg = `📊 当前连接状态：\n`

      serverList.forEach((item) => {
        msg += `\n🏰 ${item.server_name}：\n`;
        
        // WebSocket状态
        if (item.ws_able) {
          const wsInfo = wsStatus[item.server_name]
          const wsState = this._getStateEmoji(wsInfo?.state || 'disconnected')
          const wsAttempts = wsInfo?.reconnectAttempts || 0
          const hasTimer = wsInfo?.hasReconnectTimer || false
          
          msg += `├ WebSocket：${wsState} ${wsInfo?.connected ? '已连接' : '未连接'}`
          if (wsAttempts > 0) {
            msg += ` (已重试${wsAttempts}次)`
          }
          if (hasTimer) {
            msg += ` ⏱️重连中`
          }
          msg += '\n'
        } else {
          msg += `├ WebSocket：⚪ 已关闭\n`
        }
        
        // RCON状态
        if (item.rcon_able) {
          const rconInfo = rconStatus[item.server_name]
          const rconState = this._getStateEmoji(rconInfo?.state || 'disconnected')
          const rconAttempts = rconInfo?.reconnectAttempts || 0
          const hasTimer = rconInfo?.hasReconnectTimer || false
          
          msg += `└ RCON：${rconState} ${rconInfo?.connected ? '已连接' : '未连接'}`
          if (rconAttempts > 0) {
            msg += ` (已重试${rconAttempts}次)`
          }
          if (hasTimer) {
            msg += ` ⏱️重连中`
          }
          msg += '\n'
        } else {
          msg += `└ RCON：⚪ 已关闭\n`
        }
      })

      msg += '***'
      // 添加连接统计
      const rconConnected = Object.values(rconStatus).filter(s => s.connected).length
      const rconTotal = Object.keys(rconStatus).length
      const wsConnected = Object.values(wsStatus).filter(s => s.connected).length
      const wsTotal = Object.keys(wsStatus).length

      msg += `\n📈 连接统计：\n`
      if (rconTotal > 0) {
        msg += `• RCON：${rconConnected}/${rconTotal} 已连接\n`
      }
      if (wsTotal > 0) {
        msg += `• WebSocket：${wsConnected}/${wsTotal} 已连接`
      }

      msg += `\n\n💡 使用 #mc重连 可手动重连所有服务器`

      await e.reply(msg)
    } catch (error) {
      logger.error(error)
      await e.reply('❌ 查询失败，请检查配置文件')
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
