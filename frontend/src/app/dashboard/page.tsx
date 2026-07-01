import Link from 'next/link'
import VideoList from '@/components/video-list'
import { createClient } from '@/lib/supabase/server'

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [videoCountResult, clipCountResult, durationResult] = await Promise.all([
    supabase.from('videos').select('*', { count: 'exact', head: true }),
    supabase.from('clips').select('*', { count: 'exact', head: true }),
    supabase
      .from('videos')
      .select('duration_seconds')
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  const videoCount = videoCountResult.error ? 0 : (videoCountResult.count ?? 0)
  const clipCount = clipCountResult.error ? 0 : (clipCountResult.count ?? 0)
  const minutesProcessed = durationResult.error
    ? 0
    : Math.round(
        (durationResult.data?.reduce(
          (sum, video) => sum + (video.duration_seconds ?? 0),
          0,
        ) ?? 0) / 60,
      )

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-10">
        <div>
          <h2 className="text-3xl font-semibold text-black mb-2">Dashboard</h2>
          <p className="text-gray-500">Welcome back, {user?.email}</p>
        </div>
        <Link
          href="/dashboard/upload"
          className="inline-flex h-11 items-center justify-center rounded-full bg-black px-6 text-sm font-medium text-white transition-colors hover:bg-gray-800"
        >
          Upload video
        </Link>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="p-8 rounded-2xl bg-gray-50">
          <div className="text-3xl font-semibold text-black mb-1">
            {videoCount ?? 0}
          </div>
          <div className="text-sm text-gray-500">Videos uploaded</div>
        </div>
        <div className="p-8 rounded-2xl bg-gray-50">
          <div className="text-3xl font-semibold text-black mb-1">
            {clipCount ?? 0}
          </div>
          <div className="text-sm text-gray-500">Clips generated</div>
        </div>
        <div className="p-8 rounded-2xl bg-gray-50">
          <div className="text-3xl font-semibold text-black mb-1">
            {minutesProcessed}
          </div>
          <div className="text-sm text-gray-500">Minutes processed</div>
        </div>
      </div>

      <VideoList />
    </div>
  )
}