import type { Locale } from '@buddy/shared';

export const messages = {
  en: {
    resting: "Buddy is resting. This site doesn't expose agent actions yet.", detected: 'This site works with Buddy.',
    found: (n: number) => `I found ${n} things I can help you do here.`, placeholder: 'Tell Buddy what you want to do…',
    welcome: 'What would you like to accomplish on this site?', approvalTitle: 'Before I continue', approve: 'Approve once', cancel: 'Cancel',
    noTools: "This site doesn't currently offer that action through Buddy.", tabs: ['Chat', 'Activity', 'Capabilities', 'Settings'],
  },
  ar: {
    resting: 'بَدي يستريح. هذا الموقع لا يوفّر إجراءات للوكيل حتى الآن.', detected: 'هذا الموقع يعمل مع بَدي.',
    found: (n: number) => `وجدت ${n} أشياء يمكنني مساعدتك بها هنا.`, placeholder: 'أخبر بَدي بما تريد إنجازه…',
    welcome: 'ما الذي تود إنجازه في هذا الموقع؟', approvalTitle: 'قبل أن أتابع', approve: 'الموافقة لهذه المرة', cancel: 'إلغاء',
    noTools: 'هذا الموقع لا يوفّر هذا الإجراء عبر بَدي حالياً.', tabs: ['المحادثة', 'النشاط', 'الإمكانات', 'الإعدادات'],
  },
  es: {
    resting: 'Buddy está descansando. Este sitio aún no ofrece acciones de agente.', detected: 'Este sitio funciona con Buddy.',
    found: (n: number) => `Encontré ${n} cosas en las que puedo ayudarte aquí.`, placeholder: 'Cuéntale a Buddy qué quieres hacer…',
    welcome: '¿Qué te gustaría lograr en este sitio?', approvalTitle: 'Antes de continuar', approve: 'Aprobar una vez', cancel: 'Cancelar',
    noTools: 'Este sitio no ofrece esa acción mediante Buddy por ahora.', tabs: ['Chat', 'Actividad', 'Capacidades', 'Ajustes'],
  },
} as const;

export function detectLocale(language = navigator.language): Locale {
  const value = language.toLowerCase();
  if (value.startsWith('ar')) return 'ar';
  if (value.startsWith('es')) return 'es';
  return 'en';
}
export const directionFor = (locale: Locale) => locale === 'ar' ? 'rtl' : 'ltr';
