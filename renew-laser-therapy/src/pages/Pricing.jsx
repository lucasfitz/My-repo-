function Pricing() {
  const packages = [
    {
      name: 'Single Session',
      price: '65',
      duration: 'Per Session',
      description: 'Perfect for first-time visitors',
      features: [
        '20-minute session',
        'Full-body red light therapy',
        'Personalized consultation',
        'Relaxing environment',
        'No commitment required'
      ],
      popular: false
    },
    {
      name: 'Wellness Pack',
      price: '220',
      duration: '4 Sessions',
      description: 'Most popular choice',
      features: [
        '4 sessions (20 minutes each)',
        'Save $40 vs single sessions',
        'Valid for 60 days',
        'Full-body red light therapy',
        'Progress tracking',
        'Priority booking'
      ],
      popular: true,
      savings: 'Save $40'
    },
    {
      name: 'Transform Package',
      price: '520',
      duration: '10 Sessions',
      description: 'Best value for commitment',
      features: [
        '10 sessions (20 minutes each)',
        'Save $130 vs single sessions',
        'Valid for 90 days',
        'Full-body red light therapy',
        'Dedicated wellness coach',
        'Priority booking',
        'Complimentary session on birthday'
      ],
      popular: false,
      savings: 'Save $130'
    },
    {
      name: 'Monthly Unlimited',
      price: '299',
      duration: 'Per Month',
      description: 'Ultimate wellness experience',
      features: [
        'Unlimited sessions',
        'Up to 5 sessions per week',
        'Full-body red light therapy',
        'Dedicated wellness coach',
        'VIP priority booking',
        'Guest passes (2 per month)',
        'Cancel anytime'
      ],
      popular: false,
      savings: 'Best for frequent users'
    }
  ]

  const addOns = [
    {
      name: 'Extended Session',
      price: '25',
      description: 'Add 10 minutes to any session'
    },
    {
      name: 'Targeted Therapy',
      price: '35',
      description: 'Focus on specific areas with handheld device'
    },
    {
      name: 'Wellness Consultation',
      price: '50',
      description: '30-minute one-on-one with our wellness expert'
    }
  ]

  return (
    <div className="pt-20">
      {/* Header */}
      <section className="bg-gradient-to-br from-gray-50 to-white py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            Pricing & Packages
          </h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Flexible options designed to fit your wellness journey and budget
          </p>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {packages.map((pkg, index) => (
              <div
                key={index}
                className={`relative bg-white rounded-2xl shadow-lg overflow-hidden transition-all hover:scale-105 ${
                  pkg.popular ? 'ring-2 ring-red-600' : ''
                }`}
              >
                {pkg.popular && (
                  <div className="bg-red-600 text-white text-center py-2 text-sm font-semibold">
                    MOST POPULAR
                  </div>
                )}

                <div className="p-8">
                  <h3 className="text-2xl font-bold text-gray-900 mb-2">
                    {pkg.name}
                  </h3>
                  <p className="text-gray-600 mb-6">{pkg.description}</p>

                  <div className="mb-6">
                    <div className="flex items-baseline">
                      <span className="text-5xl font-bold text-gray-900">${pkg.price}</span>
                      <span className="text-gray-600 ml-2">/ {pkg.duration}</span>
                    </div>
                    {pkg.savings && (
                      <div className="mt-2 inline-block bg-green-50 text-green-700 px-3 py-1 rounded-full text-sm font-medium">
                        {pkg.savings}
                      </div>
                    )}
                  </div>

                  <ul className="space-y-3 mb-8">
                    {pkg.features.map((feature, idx) => (
                      <li key={idx} className="flex items-start">
                        <svg className="w-5 h-5 text-red-600 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-gray-600">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <a
                    href="#book"
                    className={`block w-full text-center py-3 rounded-full font-medium transition-colors ${
                      pkg.popular
                        ? 'bg-red-600 text-white hover:bg-red-700'
                        : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                    }`}
                  >
                    Select Package
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Add-Ons */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">
              Enhance Your Experience
            </h2>
            <p className="text-xl text-gray-600">
              Optional add-ons to customize your session
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {addOns.map((addon, index) => (
              <div key={index} className="bg-white p-6 rounded-xl shadow-sm">
                <div className="flex items-baseline mb-3">
                  <span className="text-3xl font-bold text-gray-900">${addon.price}</span>
                  <span className="text-gray-600 ml-2">add-on</span>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  {addon.name}
                </h3>
                <p className="text-gray-600">
                  {addon.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-4xl font-bold text-gray-900 mb-12 text-center">
            Frequently Asked Questions
          </h2>

          <div className="space-y-6">
            <div className="bg-gray-50 p-6 rounded-xl">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                How often should I do red light therapy?
              </h3>
              <p className="text-gray-600">
                For optimal results, we recommend 3-5 sessions per week. Many clients see visible improvements within 2-4 weeks of consistent use.
              </p>
            </div>

            <div className="bg-gray-50 p-6 rounded-xl">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                What should I wear during sessions?
              </h3>
              <p className="text-gray-600">
                For maximum benefit, we recommend minimal clothing or swimwear. We provide private rooms with robes for your comfort.
              </p>
            </div>

            <div className="bg-gray-50 p-6 rounded-xl">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Can I share my package with family or friends?
              </h3>
              <p className="text-gray-600">
                Single Session and Monthly Unlimited packages are non-transferable. However, Wellness Pack and Transform Package sessions can be shared with immediate family members.
              </p>
            </div>

            <div className="bg-gray-50 p-6 rounded-xl">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Do you offer corporate or group packages?
              </h3>
              <p className="text-gray-600">
                Yes! We offer customized corporate wellness packages. Contact us at info@renewlasertherapy.com for details.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="book" className="py-20 bg-gradient-to-br from-red-600 to-red-700 text-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl font-bold mb-4">
            Ready to Get Started?
          </h2>
          <p className="text-xl mb-8 text-red-100">
            Book your session today and take the first step toward optimal wellness
          </p>
          <div className="bg-white rounded-2xl p-8 text-left">
            <h3 className="text-2xl font-bold text-gray-900 mb-6">Book Your Session</h3>
            <div className="space-y-4 text-gray-600">
              <div className="flex items-center">
                <svg className="w-6 h-6 text-red-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                <div>
                  <p className="font-medium text-gray-900">Call Us</p>
                  <p>(312) 555-0123</p>
                </div>
              </div>
              <div className="flex items-center">
                <svg className="w-6 h-6 text-red-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <div>
                  <p className="font-medium text-gray-900">Email Us</p>
                  <p>info@renewlasertherapy.com</p>
                </div>
              </div>
              <div className="flex items-center">
                <svg className="w-6 h-6 text-red-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <div>
                  <p className="font-medium text-gray-900">Online Booking</p>
                  <a href="https://calendly.com/renewlasertherapy" className="text-red-600 hover:text-red-700 font-medium">
                    Schedule via Calendly →
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

export default Pricing
