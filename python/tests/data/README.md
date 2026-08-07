# Test audio

`yes_speech_i8.b85` is derived from TensorFlow Lite Micro's
[`micro_speech/testdata/yes_1000ms.wav`](https://github.com/tensorflow/tflite-micro/blob/main/tensorflow/lite/micro/examples/micro_speech/testdata/yes_1000ms.wav),
which comes from Google's [Speech Commands dataset](https://arxiv.org/abs/1804.03209) by Pete
Warden. The dataset is licensed under the
[Creative Commons Attribution 4.0 License](https://creativecommons.org/licenses/by/4.0/).

The source recording was cropped to a short speech excerpt, quantized from 16-bit to 8-bit PCM,
compressed with zlib, and encoded with Base85. These changes keep the fixture small while retaining
the recorded speech characteristics needed to exercise real speech transitions. The excerpt is
decoded only by the native VAD integration test.
