from clip_processor.main import process_video


def test_process_video():
    result = process_video("test.mp4")
    assert result["status"] == "success"
    assert result["input"] == "test.mp4"
    assert isinstance(result["clips"], list)
