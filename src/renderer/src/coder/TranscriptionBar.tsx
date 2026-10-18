import { useEffect, useRef } from 'react'
import { Mic } from 'lucide-react'
import { useTranscriptionStore } from '@/lib/store/transcription'

export function TranscriptionBar() {
  const { isTranscribing, transcriptionText } = useTranscriptionStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcriptionText])

  if (!isTranscribing && !transcriptionText) return null

  return (
    <div className="absolute top-10 left-0 right-0 px-6 pb-2 z-10">
      <div className="flex items-start gap-2 bg-app-panel rounded-lg pl-2 pr-0 py-1">
        {isTranscribing && <Mic className="w-4 h-4 mt-0.5 flex-shrink-0 opacity-70" />}
        <div
          ref={scrollRef}
          className="transcription-scroll text-sm text-app-panel-fg max-h-[4.2em] overflow-y-auto leading-[1.4em] flex-1 whitespace-pre-wrap break-words"
        >
          {transcriptionText || (isTranscribing ? '等待语音输入...' : '')}
        </div>
      </div>
    </div>
  )
}
