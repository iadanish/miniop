import UploadForm from '@/components/upload-form'

export default function UploadPage() {
  return (
    <div>
      <h2 className="text-3xl font-semibold text-black mb-2">Upload video</h2>
      <p className="text-gray-500 mb-10">
        Add a source video to start generating clips.
      </p>
      <UploadForm />
    </div>
  )
}