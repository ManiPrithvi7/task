jest.mock('@/models/DeviceCertificate', () => ({
  DeviceCertificate: {
    findOne: jest.fn()
  },
  DeviceCertificateStatus: { active: 'active' }
}));

export {};
