Weimi hardware SDKs for the fridge app.

Included (reused from the coil project):
  base-sdk-*.aar        — Weimi common/base
  annuo-sdk-*.aar       — GPIO / peripheral SDK (drives the door lock via ZtlApi)
  marshall-java-sdk.jar — Nayax card terminal (pre-auth + capture)

Deliberately NOT included:
  motor-sdk-*.aar       — coil dispensing only; the fridge has no coil motors.

Same files as snudur-sopi/app/libs. Update here too if you update the SDKs.
