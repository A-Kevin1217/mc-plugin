import plugin from '../../../lib/plugins/plugin.js'
import RconManager from '../components/Rcon.js'
import Config from '../components/Config.js'

export class OnlinePlayers extends plugin {
  constructor() {
    super({
      /** 功能名称 */
      name: 'MCQQ-在线玩家查询',
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 1009,
      rule: [
        {
          /** 命令正则匹配 */
          reg: '#?查看在线玩家$',
          /** 执行方法 */
          fnc: 'getOnlinePlayers',
        }
      ]
    })
  }

  async getOnlinePlayers(e) {
    try {
      const config = Config.getConfig()
      const { mc_qq_server_list: serverList, debug_mode: debugMode } = config

      if (!serverList || serverList.length === 0) {
        await e.reply('没有配置任何服务器')
        return true
      }

      // 查找当前群关联的服务器
      const targetServers = serverList.filter(serverCfg =>
        serverCfg.group_list?.some(groupId => groupId == e.group_id)
      )

      if (targetServers.length === 0) {
        await e.reply('当前群未关联任何服务器')
        return true
      }

      let resultMsg = '📋 在线玩家列表：\n'

      for (const serverCfg of targetServers) {
        const serverName = serverCfg.server_name
        const rconConnection = RconManager.activeConnections?.[serverName]

        if (!rconConnection) {
          resultMsg += `\n❌ ${serverName}：RCON未连接，无法查询\n`
          continue
        }

        if (debugMode) {
          logger.info(`[在线玩家查询] 向 ${serverName} 发送 list 命令`)
        }

        try {
          const response = await rconConnection.send('list')
          
          if (response) {
            const playerInfo = this._parsePlayerList(response)
            resultMsg += `\n🏰 ${serverName}：\n`
            resultMsg += `└ ${playerInfo}\n`
          } else {
            resultMsg += `\n❌ ${serverName}：查询失败，无响应\n`
          }
        } catch (error) {
          if (debugMode) {
            logger.error(`[在线玩家查询] ${serverName} 查询失败: ${error.message}`)
          }
          resultMsg += `\n❌ ${serverName}：查询失败 (${error.message})\n`
        }
      }

      await e.reply(resultMsg)
    } catch (error) {
      logger.error('[在线玩家查询] 发生错误:', error)
      await e.reply('查询在线玩家失败，请检查配置')
    }

    return true
  }

  /**
   * 解析服务器返回的玩家列表
   * @param {string} response - 服务器返回的原始响应
   * @returns {string} - 格式化后的玩家信息
   */
  _parsePlayerList(response) {
    try {
      // Minecraft服务器的list命令返回格式支持多种语言：
      // 英文: "There are 3 of a max of 20 players online: player1, player2, player3"
      // 中文: "当前共有1名玩家在线（最大玩家数为20）：baiyao"
      
      const lines = response.split('\n').filter(line => line.trim())
      
      for (const line of lines) {
        // 匹配英文格式
        const englishMatch = line.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)/i)
        
        if (englishMatch) {
          const [, currentPlayers, maxPlayers, playerList] = englishMatch
          
          if (parseInt(currentPlayers) === 0) {
            return `当前无玩家在线 (0/${maxPlayers})`
          }
          
          const players = playerList.split(',').map(p => p.trim()).filter(p => p)
          
          if (players.length > 0) {
            return `在线玩家 (${currentPlayers}/${maxPlayers})：\n   ${players.join(', ')}`
          } else {
            return `在线玩家数：${currentPlayers}/${maxPlayers}`
          }
        }
        
        // 匹配中文格式：当前共有1名玩家在线（最大玩家数为20）：baiyao
        const chineseMatch = line.match(/当前共有(\d+)名玩家在线[（(]最大玩家数为(\d+)[）)][：:]\s*(.*)/i)
        
        if (chineseMatch) {
          const [, currentPlayers, maxPlayers, playerList] = chineseMatch
          
          if (parseInt(currentPlayers) === 0) {
            return `当前无玩家在线 (0/${maxPlayers})`
          }
          
          const players = playerList.split(/[,，]/).map(p => p.trim()).filter(p => p)
          
          if (players.length > 0) {
            return `在线玩家 (${currentPlayers}/${maxPlayers})：\n └ ${players.join(', ')}`
          } else {
            return `在线玩家数：${currentPlayers}/${maxPlayers}`
          }
        }
        
        // 匹配其他可能的中文格式
        const altChineseMatch = line.match(/.*?(\d+).*?玩家.*?在线.*?(\d+).*?([:：]\s*(.*))?/i)
        
        if (altChineseMatch) {
          const [, currentPlayers, maxPlayers, , playerList] = altChineseMatch
          
          if (parseInt(currentPlayers) === 0) {
            return `当前无玩家在线 (0/${maxPlayers})`
          }
          
          if (playerList && playerList.trim()) {
            const players = playerList.split(/[,，]/).map(p => p.trim()).filter(p => p)
            return `在线玩家 (${currentPlayers}/${maxPlayers})：\n   ${players.join(', ')}`
          } else {
            return `在线玩家数：${currentPlayers}/${maxPlayers}`
          }
        }
      }
      
      // 如果无法解析，返回原始响应
      return `服务器响应：${response}`
    } catch (error) {
      logger.error('[在线玩家查询] 解析响应失败:', error)
      return `解析失败，原始响应：${response}`
    }
  }
}
