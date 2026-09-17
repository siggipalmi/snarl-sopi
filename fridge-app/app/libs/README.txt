Weimi hardware SDKs for the fridge app.

All four files here are REQUIRED. build.gradle.kts pulls the whole directory
in with fileTree("libs"), so deleting one breaks the build.

  base-sdk-*.aar        — Weimi common/base.
  motor-sdk-*.aar       — the real serial framework. Despite the name it is NOT
                          coil-only: MotorSerialPortKit drives the weight bus
                          and the door lock (WeightInstruct/LockInstruct), and
                          com.weimi.motorserial.instruct.EnergyInstruct carries
                          the cabinet's temperature, lighting and defrost —
                          ctlTemp, ctlLed, ledBrightnessAdjustment, ctrlDefrost.
  annuo-sdk-*.aar       — GPIO / peripheral SDK (ZtlApi).
  marshall-java-sdk.jar — Nayax card terminal (pre-auth + capture).

*** THIS FILE PREVIOUSLY SAID motor-sdk WAS "deliberately NOT included: coil
dispensing only; the fridge has no coil motors". That was wrong on both counts
and dangerous: the file has always been present, build.gradle.kts says in its
own comment that motor-sdk IS required for the fridge, and it is the archive
containing every energy-board instruction the fridge uses. Anyone tidying up
by following the old note would have deleted temperature control along with
the lights. Corrected 2026-09-17 while implementing set_led and defrost.

Same files as snudur-sopi/app/libs. Update here too if you update the SDKs.
