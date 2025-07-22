import { middleware, Client } from '@line/bot-sdk'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import getRawBody from 'raw-body'

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
})

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export const config = {
  api: {
    bodyParser: false,
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed')
    return
  }

  const rawBody = await getRawBody(req)
  const signature = req.headers['x-line-signature']

  const parser = middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET })
  parser({ ...req, rawBody }, res, async () => {
    const body = JSON.parse(rawBody.toString())
    const event = body.events?.[0]
    const userMessage = event?.message?.text
    const replyToken = event?.replyToken

    if (!userMessage || !replyToken) return res.status(200).send('No message')

    const systemPrompt = `你是亞鈺汽車的50年資深客服專員，擅長解決問題並能細緻拆解每個問題，態度積極且充滿溫度。你接下來會根據參考資料進行回答，請遵守以下規則：

1. 先判斷問題是否能與參考資料連結，並只詢問與參考資料有關的條件。
2. 若問題不在參考資料中，請先辨識問題的類型（如車輛查詢、價格詢問、地點問題…）。
3. 針對無法立即回答的問題，請回問使用者需要的條件（如車款、年份、品牌…），並循序引導直到取得答案。
4. 如果問題與參考資料完全無關，例如閒聊、非亞鈺汽車業務問題，請統一回覆：「感謝您的詢問，請詢問亞鈺汽車相關問題，我們很高興為您服務！😄」
5. 所有回覆請保持：直接回答、積極熱情、條理清晰、有溫度。
6. 請避免反問不相關內容，所有對話都要有效率地引導對方取得答案。
你現在可以開始回答問題了。`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })

    let extracted
    try {
      extracted = JSON.parse(completion.choices[0].message.content)
    } catch {
      extracted = {}
    }

    const { brand, model, year } = extracted
    if (brand || model || year) {
      const { data } = await supabase
        .from('cars')
        .select('*')
        .ilike('廠牌', brand ? `%${brand}%` : '%')
        .ilike('車型', model ? `%${model}%` : '%')
        .gte('年份', year || 0)

      const reply = data?.length
        ? data.map(c => `🚗 ${c.廠牌} ${c.車型} ${c.年份}年｜售價：${c.車輛售價}萬`).join('\n')
        : '目前找不到符合的車輛喔～可以再提供更明確的條件嗎？'

      await client.replyMessage(replyToken, { type: 'text', text: reply })
      return res.status(200).send('OK')
    }

    const fallback = completion.choices[0].message.content
    await client.replyMessage(replyToken, { type: 'text', text: fallback })
    res.status(200).send('OK')
  })
}
