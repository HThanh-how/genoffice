import type { zh } from './zh'

export const hi = {
  agyErrQuota:
    'आपका Antigravity उपयोग कोटा समाप्त हो गया है। रीसेट होने तक प्रतीक्षा करें, या सेटिंग्स में किसी अन्य मॉडल या प्रदाता पर स्विच करें।',
  agyErrQuotaAt:
    'आपका Antigravity उपयोग कोटा समाप्त हो गया है। रीसेट का समय: {time}। रीसेट होने तक प्रतीक्षा करें, या सेटिंग्स में किसी अन्य मॉडल या प्रदाता पर स्विच करें।',
  agyErrAuth:
    'Antigravity में साइन इन नहीं है, या सत्र समाप्त हो गया है। सेटिंग्स → AI मॉडल में फिर से साइन इन करें।',
} satisfies Record<keyof typeof zh, string>
